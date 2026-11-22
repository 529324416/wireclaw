import { HarnessError, HarnessErrorCode } from "../base/error";
import { HarnessBuiltinNodeType } from "../definition";
import { GraphNode } from "../graph/node";
import type { NodeContext } from "../graph/node";
import type {
    HarnessValue,
    InputPortSpec,
    NodeInputValues,
    NodeOutputValues,
    OutputPortSpec,
} from "../graph/type";
import { isChatProvider } from "../../session/protocol";
import { system } from "../../session/message";
import {
    RunStatus,
    Session,
    SessionHistory,
} from "../../session/session";
import type { Run } from "../../session/session";
import type { SessionHostOptions } from "../../session/session";
import { SessionEventType, SessionPermission } from "../../session/type";
import type { SessionRuntimeOptions } from "../../session/type";
import {
    attachmentRefs,
    buildUserContent,
    contentAttachments,
    contentToText,
    errorText,
    findLastAssistant,
    readConfig,
    readOptionalBoolean,
    readOptionalPositiveInteger,
    readOptionalString,
    requireModelBinding,
    requireText,
    usageToJson,
} from "./helpers";

const AGENT_RUN = HarnessBuiltinNodeType.AgentRun;

/** B 类节点：Session/AgentLoop 包装；工具、审批、人工输入由宿主桥接 */
export class AgentRunNode extends GraphNode{

    override readonly type = AGENT_RUN;

    override get inputs(): readonly InputPortSpec[]{
        return [
            { name: "model", type: "model", required: true },
            { name: "input", type: "text", required: true },
            { name: "attachments", type: "attachments" },
        ];
    }

    override get outputs(): readonly OutputPortSpec[]{
        return [
            {
                name: "text",
                type: "text",
                supportedModes: ["value", "stream"],
                defaultMode: "value",
            },
            {
                name: "thinking",
                type: "text",
                supportedModes: ["value"],
                defaultMode: "value",
            },
            {
                name: "attachments",
                type: "attachments",
                supportedModes: ["value"],
                defaultMode: "value",
            },
            {
                name: "usage",
                type: "json",
                supportedModes: ["value"],
                defaultMode: "value",
            },
            {
                name: "stopReason",
                type: "text",
                supportedModes: ["value"],
                defaultMode: "value",
            },
        ];
    }

    override async execute(
        ctx: NodeContext,
        inputs: NodeInputValues,
    ): Promise<NodeOutputValues>{
        const config = readConfig(this.config, this.type);
        const binding = requireModelBinding(inputs.model);
        const input = requireText(inputs.input, "input");
        const attachments = attachmentRefs(inputs.attachments);
        const provider = ctx.services.resolveModel(binding);

        if (!isChatProvider(provider)){
            throw new HarnessError(
                HarnessErrorCode.InvalidNode,
                `Model "${binding.modelId}" does not support chat`,
                { nodeId: this.id },
            );
        }

        const permission = readPermission(config);
        const maxSteps = readOptionalPositiveInteger(config, "maxSteps", this.type) ?? 8;
        const systemPrompt = readOptionalString(config, "system", this.type);
        const hostOptions = readHostOptions(config);
        const history = new SessionHistory(
            undefined,
            systemPrompt === undefined ? [] : [system(systemPrompt)],
        );
        const runtimeOptions = readRuntimeOptions(config, binding);
        const session = new Session(
            provider,
            history,
            runtimeOptions,
            ctx.services.attachments,
            hostOptions,
        );

        let handlerError: unknown;
        const unsubscribe = session.subscribe((event) =>{
            if (event.type === SessionEventType.TOOL_APPROVAL_REQUIRED){
                const handler = ctx.services.onToolApproval;
                if (handler === undefined){
                    handlerError = new HarnessError(
                        HarnessErrorCode.NodeExecutionFailed,
                        "B 节点需要工具审批，但宿主没有提供 onToolApproval",
                        { nodeId: this.id },
                    );
                    session.cancel();
                    return;
                }

                void Promise.resolve(handler({
                    call: event.call,
                    tool: event.tool,
                })).then((decision) =>{
                    if (!session.resume(decision)) session.cancel();
                }).catch((error: unknown) =>{
                    handlerError = error;
                    session.cancel();
                });
                return;
            }

            if (event.type === SessionEventType.TOOL_INPUT_REQUIRED){
                const handler = ctx.services.onUserInput;
                if (handler === undefined){
                    handlerError = new HarnessError(
                        HarnessErrorCode.NodeExecutionFailed,
                        "B 节点调用了 host__ask_user，但宿主没有提供 onUserInput",
                        { nodeId: this.id },
                    );
                    session.cancel();
                    return;
                }

                void Promise.resolve(handler(event.request)).then((result) =>{
                    if (!session.respondUserInput(result)) session.cancel();
                }).catch((error: unknown) =>{
                    handlerError = error;
                    session.cancel();
                });
            }
        });

        let run: Run;
        try{
            run = await session.run(
                buildUserContent(input, attachments),
                {
                    tools: ctx.services.tools,
                    permission,
                    maxSteps,
                    enableUserInput: hostOptions.hostTools === true
                        || (typeof hostOptions.hostTools === "object"
                            && hostOptions.hostTools.askUser !== false),
                    toolProgressDelayMs: 0,
                },
            );
        }finally{
            unsubscribe();
        }

        if (handlerError !== undefined){
            throw new HarnessError(
                HarnessErrorCode.NodeExecutionFailed,
                `B 节点宿主回调失败: ${errorText(handlerError)}`,
                { nodeId: this.id, origin: handlerError },
            );
        }
        if (run.status !== RunStatus.Completed){
            throw new HarnessError(
                HarnessErrorCode.NodeExecutionFailed,
                `B 节点运行失败: ${run.error === undefined ? run.status : errorText(run.error)}`,
                { nodeId: this.id, origin: run.error },
            );
        }

        const assistant = findLastAssistant(run.pendingMessages);
        if (assistant === undefined){
            throw new HarnessError(
                HarnessErrorCode.NodeExecutionFailed,
                "B 节点运行完成但没有 assistant 消息",
                { nodeId: this.id },
            );
        }

        const outputs: Record<string, HarnessValue> = {
            text: { type: "text", text: contentToText(assistant.content) },
            attachments: {
                type: "attachments",
                attachments: contentAttachments(assistant.content),
            },
            usage: { type: "json", value: usageToJson(assistant.usage) },
        };
        if (assistant.thinking !== undefined){
            outputs.thinking = { type: "text", text: assistant.thinking };
        }
        if (assistant.stopReason !== undefined){
            outputs.stopReason = { type: "text", text: assistant.stopReason };
        }
        return outputs;
    }
}

function readPermission(config: Record<string, unknown>): SessionPermission{
    const value = config.permission;
    if (value === undefined) return SessionPermission.ReadOnly;
    if (value !== SessionPermission.ReadOnly
        && value !== SessionPermission.Approval
        && value !== SessionPermission.Full){
        throw new HarnessError(
            HarnessErrorCode.InvalidNode,
            `${AGENT_RUN}.permission must be readonly, approval or full`,
        );
    }
    return value;
}

function readHostOptions(config: Record<string, unknown>): SessionHostOptions{
    const value = config.hostTools;
    if (value === undefined) return { hostTools: false };
    if (typeof value === "boolean") return { hostTools: value };
    if (typeof value !== "object" || value === null || Array.isArray(value)){
        throw new HarnessError(
            HarnessErrorCode.InvalidNode,
            `${AGENT_RUN}.hostTools must be a boolean or an object`,
        );
    }

    const record = value as Record<string, unknown>;
    const askUser = record.askUser;
    const viewMedia = record.viewMedia;
    if (askUser !== undefined && typeof askUser !== "boolean"){
        throw new HarnessError(
            HarnessErrorCode.InvalidNode,
            `${AGENT_RUN}.hostTools.askUser must be a boolean`,
        );
    }
    if (viewMedia !== undefined && typeof viewMedia !== "boolean"){
        throw new HarnessError(
            HarnessErrorCode.InvalidNode,
            `${AGENT_RUN}.hostTools.viewMedia must be a boolean`,
        );
    }

    return {
        hostTools: {
            ...(askUser === undefined ? {} : { askUser }),
            ...(viewMedia === undefined ? {} : { viewMedia }),
        },
    };
}

function readRuntimeOptions(
    config: Record<string, unknown>,
    binding: { modelId: string },
): SessionRuntimeOptions{
    const think = readOptionalBoolean(config, "think", AGENT_RUN);
    const thinkingLv = config.thinkingLv;
    if (thinkingLv !== undefined
        && typeof thinkingLv !== "string"
        && typeof thinkingLv !== "number"){
        throw new HarnessError(
            HarnessErrorCode.InvalidNode,
            `${AGENT_RUN}.thinkingLv must be a string or number`,
        );
    }

    const temperature = config.temperature;
    if (temperature !== undefined && typeof temperature !== "number"){
        throw new HarnessError(
            HarnessErrorCode.InvalidNode,
            `${AGENT_RUN}.temperature must be a number`,
        );
    }

    return {
        model: binding.modelId,
        ...(think === undefined ? {} : { think }),
        ...(thinkingLv === undefined ? {} : { thinkingLv }),
        ...(temperature === undefined ? {} : { temperature }),
    };
}
