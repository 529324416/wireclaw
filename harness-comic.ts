import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
    Edge,
    Graph,
    GraphNode,
    HarnessBuiltinNodeType,
    HarnessError,
    HarnessErrorCode,
} from "./src/harness";
import type {
    GraphEvent,
    GraphRunResult,
    InputPortSpec,
    JsonValue,
    NodeContext,
    NodeInputValues,
    NodeOutputValues,
    OutputPortSpec,
} from "./src/harness";
import { isRecord } from "./src/harness/base/utils";
import {
    createPipelineRuntime,
    modelNode,
} from "./harness-runtime";
import type { PipelineRuntime } from "./harness-runtime";

const DEFAULT_TOPIC = "一只小机器人在屋顶花园里照顾最后一株向日葵";
const DEFAULT_PLAN_MODEL = "qwen-plus";
const DEFAULT_IMAGE_MODEL = "qwen3.8-flash";
const DEFAULT_VISION_MODEL = "qwen3-vl-plus";
const MAX_ATTEMPTS = 3;
const IMAGE_TOOL = "comfyui-image__generateImage";

const PLAN_SYSTEM = [
    "You are a comic director.",
    "Turn the user's idea into exactly 4 panel briefs for a four-panel comic.",
    "Panel 1 establishes the scene, panel 2 introduces the turn, panel 3 shows the conflict,",
    "panel 4 pays it off with a visual punchline.",
    "Keep the same main character, rooftop setting and golden-hour palette across all panels.",
    "Return ONLY a JSON array of exactly 4 strings.",
    "Each string must describe subject, action, composition and mood in one sentence.",
    "No markdown, no object wrappers.",
].join(" ");

const IMAGE_SYSTEM = [
    "You are the image production stage of a four-panel comic.",
    `You must call the tool ${IMAGE_TOOL} exactly once with the prompt you receive.`,
    "Do not ask questions and do not answer before the tool call.",
    "After the tool returns, reply with one short sentence describing the result.",
].join(" ");

const REVIEW_SYSTEM = [
    "You are a pragmatic comic art director.",
    "Pass the panel when it clearly conveys the brief's main subject and action,",
    "is a single coherent cinematic image, and has no text/lettering/watermark.",
    "Minor deviations in exact props, eye glow, lighting or background are acceptable;",
    "do not fail for those.",
    "Fail only for a clearly wrong subject/action, multiple disconnected scenes,",
    "visible text, or an unusable image.",
    "Return ONLY JSON: {\"passed\":true|false,\"feedback\":\"one concise sentence in Chinese\"}.",
].join(" ");

class ComicPlanNode extends GraphNode{

    override readonly type = "comic.plan";

    override get inputs(): readonly InputPortSpec[]{
        return [{ name: "text", type: "text", required: true }];
    }

    override get outputs(): readonly OutputPortSpec[]{
        return [{ name: "panels", type: "json" }];
    }

    override async execute(
        _ctx: NodeContext,
        inputs: NodeInputValues,
    ): Promise<NodeOutputValues>{
        const value = inputs.text;
        if (value?.type !== "text"){
            throw new HarnessError(
                HarnessErrorCode.InvalidValue,
                "comic.plan expects text",
                { nodeId: this.id },
            );
        }

        const start = value.text.indexOf("[");
        const end = value.text.lastIndexOf("]");
        if (start < 0 || end <= start){
            throw new HarnessError(
                HarnessErrorCode.InvalidValue,
                "comic.plan could not find a JSON array",
                { nodeId: this.id },
            );
        }

        let parsed: unknown;
        try{
            parsed = JSON.parse(value.text.slice(start, end + 1));
        }catch(error){
            throw new HarnessError(
                HarnessErrorCode.InvalidValue,
                `comic.plan invalid JSON: ${String(error)}`,
                { nodeId: this.id, origin: error },
            );
        }

        if (!Array.isArray(parsed) || parsed.length !== 4){
            throw new HarnessError(
                HarnessErrorCode.InvalidValue,
                "comic.plan requires exactly 4 panels",
                { nodeId: this.id },
            );
        }

        const panels = parsed.map((panel) =>{
            if (typeof panel === "string") return panel;
            if (isRecord(panel) && typeof panel.prompt === "string") return panel.prompt;
            return JSON.stringify(panel);
        });

        return { panels: { type: "json", value: panels } };
    }
}

class PanelInitNode extends GraphNode{

    override readonly type = "comic.panelInit";

    override get inputs(): readonly InputPortSpec[]{
        return [
            { name: "panel", type: "any", required: true },
            { name: "iteration", type: "json", required: true },
        ];
    }

    override get outputs(): readonly OutputPortSpec[]{
        return [{ name: "state", type: "json" }];
    }

    override async execute(
        _ctx: NodeContext,
        inputs: NodeInputValues,
    ): Promise<NodeOutputValues>{
        const panel = inputs.panel;
        const text = panel?.type === "text"
            ? panel.text
            : panel?.type === "json" && typeof panel.value === "string"
                ? panel.value
                : JSON.stringify(panel);

        const iteration = inputs.iteration;
        const panelIndex = iteration?.type === "json"
            && typeof iteration.value === "number"
            ? iteration.value
            : 0;

        return {
            state: {
                type: "json",
                value: {
                    panel: text,
                    panelIndex,
                    attempt: 0,
                    feedback: "",
                    passed: false,
                },
            },
        };
    }
}

class PromptComposerNode extends GraphNode{

    override readonly type = "comic.prompt";

    override get inputs(): readonly InputPortSpec[]{
        return [{ name: "state", type: "any", required: true }];
    }

    override get outputs(): readonly OutputPortSpec[]{
        return [{ name: "text", type: "text" }];
    }

    override async execute(
        _ctx: NodeContext,
        inputs: NodeInputValues,
    ): Promise<NodeOutputValues>{
        const state = readState(inputs.state);
        const clean = (value: string): string => value
            .replace(/["\\]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        const panel = clean(String(state.panel ?? ""));
        const feedback = typeof state.feedback === "string" && state.feedback.length > 0
            ? `Previous review feedback: ${clean(state.feedback)} Fix those issues.`
            : "";

        return {
            text: {
                type: "text",
                text: [
                    "Create ONE panel for a four-panel comic. Do not draw a grid.",
                    `Panel brief: ${panel}`,
                    `Attempt: ${String(state.attempt ?? 0)}.`,
                    "Style: cinematic 3D animated film still, expressive characters,",
                    "detailed rooftop garden, warm golden-hour light, 1:1 composition.",
                    "Keep the same small rounded robot with two glowing eyes and chipped white shell",
                    "as the main character in every panel.",
                    "No text, no lettering, no watermark, no speech bubbles.",
                    feedback,
                ].join(" "),
            },
        };
    }
}

class ReviewPromptNode extends GraphNode{

    override readonly type = "comic.reviewPrompt";

    override get inputs(): readonly InputPortSpec[]{
        return [{ name: "state", type: "any", required: true }];
    }

    override get outputs(): readonly OutputPortSpec[]{
        return [{ name: "text", type: "text" }];
    }

    override async execute(
        _ctx: NodeContext,
        inputs: NodeInputValues,
    ): Promise<NodeOutputValues>{
        const state = readState(inputs.state);
        return {
            text: {
                type: "text",
                text: [
                    "Panel brief:",
                    String(state.panel ?? ""),
                    "",
                    "Judge the main subject and action, not exact minor details.",
                    "Pass if the scene is recognizable, coherent and text-free.",
                    "Fail only for a clearly wrong subject/action, multiple disconnected scenes,",
                    "visible text, or an unusable image.",
                ].join("\n"),
            },
        };
    }
}

class ReviewDecisionNode extends GraphNode{

    override readonly type = "comic.reviewDecision";

    override get inputs(): readonly InputPortSpec[]{
        return [
            { name: "state", type: "any", required: true },
            { name: "review", type: "text", required: true },
        ];
    }

    override get outputs(): readonly OutputPortSpec[]{
        return [{ name: "json", type: "json" }];
    }

    override async execute(
        ctx: NodeContext,
        inputs: NodeInputValues,
    ): Promise<NodeOutputValues>{
        const state = readState(inputs.state);
        const review = inputs.review;
        if (review?.type !== "text"){
            throw new HarnessError(
                HarnessErrorCode.InvalidValue,
                "comic.reviewDecision expects review text",
                { nodeId: this.id },
            );
        }

        const decision = parseReview(review.text);
        let passed = decision.passed;
        let feedback = decision.feedback;

        const forcePanel = process.env.COMIC_FORCE_RETRY_PANEL;
        if (forcePanel !== undefined
            && String(state.panelIndex ?? "") === forcePanel
            && state.attempt === 0){
            passed = false;
            feedback = "Rehearsal override: force one retry for this panel.";
        }

        const nextState = {
            ...state,
            attempt: (typeof state.attempt === "number" ? state.attempt : 0) + 1,
            feedback,
            passed,
        };

        ctx.publish("comic.review", {
            panelIndex: typeof state.panelIndex === "number" ? state.panelIndex : -1,
            attempt: nextState.attempt,
            passed,
            feedback,
        });

        return {
            json: {
                type: "json",
                value: {
                    state: nextState,
                    done: passed,
                },
            },
        };
    }
}

function readState(value: NodeInputValues[string] | undefined): Record<string, unknown>{
    if (value?.type !== "json" || !isRecord(value.value)){
        throw new HarnessError(
            HarnessErrorCode.InvalidValue,
            "comic state must be a JSON object",
        );
    }
    return value.value;
}

function parseReview(text: string): { passed: boolean; feedback: string }{
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start){
        try{
            const parsed = JSON.parse(text.slice(start, end + 1));
            if (isRecord(parsed) && typeof parsed.passed === "boolean"){
                return {
                    passed: parsed.passed,
                    feedback: typeof parsed.feedback === "string"
                        ? parsed.feedback
                        : parsed.passed ? "passed" : "review failed",
                };
            }
        }catch{
            // fall through to strict failure
        }
    }

    return {
        passed: false,
        feedback: text.trim().slice(0, 500) || "review did not return valid JSON",
    };
}

function registerComicNodes(registry: PipelineRuntime["registry"]): void{
    registry.register({
        type: "comic.plan",
        version: 1,
        create: (id, config, inputs, ui) => new ComicPlanNode(id, config, inputs, ui),
    });
    registry.register({
        type: "comic.panelInit",
        version: 1,
        create: (id, config, inputs, ui) => new PanelInitNode(id, config, inputs, ui),
    });
    registry.register({
        type: "comic.prompt",
        version: 1,
        create: (id, config, inputs, ui) => new PromptComposerNode(id, config, inputs, ui),
    });
    registry.register({
        type: "comic.reviewPrompt",
        version: 1,
        create: (id, config, inputs, ui) => new ReviewPromptNode(id, config, inputs, ui),
    });
    registry.register({
        type: "comic.reviewDecision",
        version: 1,
        create: (id, config, inputs, ui) => new ReviewDecisionNode(id, config, inputs, ui),
    });
}

function createRetryGraph(registry: PipelineRuntime["registry"]): Graph{
    const state = registry.createNode({
        id: "state",
        type: HarnessBuiltinNodeType.Value,
        typeVersion: 1,
        config: { name: "state" },
    });
    const composer = registry.createNode({
        id: "composer",
        type: "comic.prompt",
        typeVersion: 1,
    });
    const imageModel = modelNode(
        registry,
        "imageModel",
        process.env.HARNESS_IMAGE_MODEL ?? DEFAULT_IMAGE_MODEL,
    );
    const image = registry.createNode({
        id: "image",
        type: HarnessBuiltinNodeType.AgentRun,
        typeVersion: 1,
        config: {
            system: IMAGE_SYSTEM,
            permission: "full",
            maxSteps: 4,
            hostTools: false,
        },
    });
    const toolset = registry.createNode({
        id: "toolset",
        type: HarnessBuiltinNodeType.ToolSet,
        typeVersion: 1,
        config: { include: [IMAGE_TOOL] },
    });
    const reviewPrompt = registry.createNode({
        id: "reviewPrompt",
        type: "comic.reviewPrompt",
        typeVersion: 1,
    });
    const reviewModel = modelNode(
        registry,
        "reviewModel",
        process.env.HARNESS_VISION_MODEL ?? DEFAULT_VISION_MODEL,
    );
    const review = registry.createNode({
        id: "review",
        type: HarnessBuiltinNodeType.ModelCall,
        typeVersion: 1,
        config: { system: REVIEW_SYSTEM, temperature: 0.1 },
    });
    const decision = registry.createNode({
        id: "decision",
        type: "comic.reviewDecision",
        typeVersion: 1,
    });
    const output = registry.createNode({
        id: "output",
        type: HarnessBuiltinNodeType.Output,
        typeVersion: 1,
    });

    return new Graph([
        state,
        composer,
        imageModel,
        image,
        toolset,
        reviewPrompt,
        reviewModel,
        review,
        decision,
        output,
    ], [
        new Edge({ nodeId: "state", port: "value" }, { nodeId: "composer", port: "state" }),
        new Edge({ nodeId: "composer", port: "text" }, { nodeId: "image", port: "input" }),
        new Edge({ nodeId: "imageModel", port: "model" }, { nodeId: "image", port: "model" }),
        new Edge({ nodeId: "toolset", port: "toolset" }, { nodeId: "image", port: "toolset" }),
        new Edge({ nodeId: "state", port: "value" }, { nodeId: "reviewPrompt", port: "state" }),
        new Edge({ nodeId: "reviewPrompt", port: "text" }, { nodeId: "review", port: "prompt" }),
        new Edge({ nodeId: "image", port: "attachments" }, { nodeId: "review", port: "attachments" }),
        new Edge({ nodeId: "reviewModel", port: "model" }, { nodeId: "review", port: "model" }),
        new Edge({ nodeId: "state", port: "value" }, { nodeId: "decision", port: "state" }),
        new Edge({ nodeId: "review", port: "text" }, { nodeId: "decision", port: "review" }),
        new Edge({ nodeId: "decision", port: "json" }, { nodeId: "output", port: "json" }),
        new Edge({ nodeId: "image", port: "attachments" }, { nodeId: "output", port: "attachments" }),
    ], { id: "comic-panel-retry" });
}

function createPanelGraph(
    registry: PipelineRuntime["registry"],
    retryDocument: unknown,
): Graph{
    const item = registry.createNode({
        id: "item",
        type: HarnessBuiltinNodeType.Value,
        typeVersion: 1,
        config: { name: "item" },
    });
    const iteration = registry.createNode({
        id: "iteration",
        type: HarnessBuiltinNodeType.Value,
        typeVersion: 1,
        config: { name: "iteration" },
    });
    const init = registry.createNode({
        id: "init",
        type: "comic.panelInit",
        typeVersion: 1,
    });
    const loop = registry.createNode({
        id: "loop",
        type: HarnessBuiltinNodeType.Loop,
        typeVersion: 1,
        config: {
            graph: retryDocument,
            maxIterations: MAX_ATTEMPTS,
            retryOnError: true,
        } as never,
    });
    const output = registry.createNode({
        id: "output",
        type: HarnessBuiltinNodeType.Output,
        typeVersion: 1,
    });

    return new Graph([item, iteration, init, loop, output], [
        new Edge({ nodeId: "item", port: "value" }, { nodeId: "init", port: "panel" }),
        new Edge({ nodeId: "iteration", port: "value" }, { nodeId: "init", port: "iteration" }),
        new Edge({ nodeId: "init", port: "state" }, { nodeId: "loop", port: "initial" }),
        new Edge({ nodeId: "loop", port: "value" }, { nodeId: "output", port: "json" }),
        new Edge({ nodeId: "loop", port: "attachments" }, { nodeId: "output", port: "attachments" }),
    ], { id: "comic-panel" });
}

function createComicGraph(runtime: PipelineRuntime): Graph{
    const registry = runtime.registry;
    const input = registry.createNode({
        id: "input",
        type: HarnessBuiltinNodeType.Input,
        typeVersion: 1,
    });
    const planModel = modelNode(
        registry,
        "planModel",
        process.env.HARNESS_PLAN_MODEL ?? DEFAULT_PLAN_MODEL,
    );
    const planCall = registry.createNode({
        id: "planCall",
        type: HarnessBuiltinNodeType.ModelCall,
        typeVersion: 1,
        config: { system: PLAN_SYSTEM, temperature: 0.8 },
    });
    const plan = registry.createNode({
        id: "plan",
        type: "comic.plan",
        typeVersion: 1,
    });
    const forEach = registry.createNode({
        id: "panels",
        type: HarnessBuiltinNodeType.ForEach,
        typeVersion: 1,
        config: {
            graph: createPanelGraph(registry, createRetryGraph(registry).toJSON()).toJSON(),
            resultPort: "json",
        } as never,
    });
    const output = registry.createNode({
        id: "output",
        type: HarnessBuiltinNodeType.Output,
        typeVersion: 1,
    });

    return new Graph([input, planModel, planCall, plan, forEach, output], [
        new Edge({ nodeId: "input", port: "text" }, { nodeId: "planCall", port: "prompt" }),
        new Edge({ nodeId: "planModel", port: "model" }, { nodeId: "planCall", port: "model" }),
        new Edge({ nodeId: "planCall", port: "text" }, { nodeId: "plan", port: "text" }),
        new Edge({ nodeId: "plan", port: "panels" }, { nodeId: "panels", port: "items" }),
        new Edge({ nodeId: "panels", port: "attachments" }, { nodeId: "output", port: "attachments" }),
        new Edge({ nodeId: "panels", port: "results" }, { nodeId: "output", port: "json" }),
    ], {
        id: "four-panel-comic",
        title: "Four-panel comic",
        toolSet: {
            include: [IMAGE_TOOL],
            hostTools: { askUser: false, viewMedia: false },
        },
    });
}

function getJson(outputs: NodeOutputValues, port: string): JsonValue | undefined{
    const value = outputs[port];
    return value?.type === "json" ? value.value : undefined;
}

function reviewSummary(result: GraphRunResult): {
    passed: number;
    failed: number;
    attempts: number;
}[]{
    const output = result.outputs.json;
    if (output?.type !== "json" || !Array.isArray(output.value)) return [];

    return output.value.map((item) =>{
        if (!isRecord(item) || !isRecord(item.value)){
            return { passed: 0, failed: 1, attempts: 0 };
        }
        const state = isRecord(item.value.state) ? item.value.state : item.value;
        return {
            passed: state.passed === true ? 1 : 0,
            failed: state.passed === true ? 0 : 1,
            attempts: typeof state.attempt === "number" ? state.attempt : 0,
        };
    });
}

async function saveComic(
    runtime: PipelineRuntime,
    result: GraphRunResult,
    events: readonly GraphEvent[],
    topic: string,
): Promise<{ panels: string[]; sheet?: string; statePath: string }>{
    const outputDir = resolve(process.cwd(), "comic-output");
    await mkdir(outputDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");

    const planEvent = events.find((event) => event.type === "node:end" && event.nodeId === "plan");
    const plan = planEvent?.type === "node:end" ? getJson(planEvent.outputs, "panels") : undefined;
    await writeFile(
        resolve(outputDir, `${stamp}-plan.json`),
        `${JSON.stringify({ topic, panels: plan }, null, 2)}\n`,
        "utf8",
    );

    const statePath = resolve(outputDir, `${stamp}-panels.json`);
    await writeFile(
        statePath,
        `${JSON.stringify(result.outputs.json, null, 2)}\n`,
        "utf8",
    );

    const panels: string[] = [];
    const attachments = result.outputs.attachments;
    if (attachments?.type === "attachments"){
        for (const [index, ref] of attachments.attachments.entries()){
            const file = await runtime.attachments.get(ref.contentHash);
            if (file === undefined) continue;
            const extension = file.mimeType === "image/jpeg" ? "jpg" : "png";
            const path = resolve(outputDir, `${stamp}-panel-${String(index + 1)}.${extension}`);
            await writeFile(path, file.content);
            panels.push(path);
        }
    }

    let sheet: string | undefined;
    if (panels.length === 4){
        sheet = resolve(outputDir, `${stamp}-comic.png`);
        const filter = [
            "[0:v]scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2,setsar=1[a]",
            "[1:v]scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2,setsar=1[b]",
            "[2:v]scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2,setsar=1[c]",
            "[3:v]scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2,setsar=1[d]",
            "[a][b]hstack=inputs=2[top]",
            "[c][d]hstack=inputs=2[bottom]",
            "[top][bottom]vstack=inputs=2[out]",
        ].join(";");
        const args = [
            "-y",
            ...panels.flatMap((panel) => ["-i", panel]),
            "-filter_complex", filter,
            "-map", "[out]",
            "-frames:v", "1",
            sheet,
        ];
        const run = spawnSync(process.env.FFMPEG_PATH ?? "ffmpeg", args, {
            stdio: "ignore",
        });
        if (run.status !== 0){
            console.error(`[comic] ffmpeg montage failed: ${String(run.error ?? run.status)}`);
            sheet = undefined;
        }
    }

    return { panels, sheet, statePath };
}

async function main(): Promise<void>{
    const topic = process.argv.slice(2).join(" ").trim() || DEFAULT_TOPIC;
    console.log(`[comic] topic: ${topic}`);
    console.log("[comic] preparing planner / image / reviewer runtime...");

    const runtime = await createPipelineRuntime();
    registerComicNodes(runtime.registry);
    const graph = createComicGraph(runtime);
    graph.assertValid();

    const events: GraphEvent[] = [];
    const started = Date.now();
    const result = await graph.run({
        host: {
            resolveProvider: (id) => id === "qwen" ? runtime.provider : undefined,
            tools: runtime.tools,
            attachments: runtime.attachments,
            onToolApproval: (request, nodeId) =>{
                console.log(`[approval] ${nodeId}: ${request.call.name}`);
                return "approve";
            },
            log: (level, message) =>{
                if (level !== "debug") console.log(`[${level}] ${message}`);
            },
        },
        input: { text: topic },
        listener: (event) =>{
            events.push(event);
            if (event.type === "custom" && event.name.endsWith("comic.review")){
                const payload = event.payload;
                if (isRecord(payload)){
                    console.log(
                        `[review] panel=${String(payload.panelIndex)} `
                        + `attempt=${String(payload.attempt)} `
                        + `${payload.passed === true ? "PASS" : "FAIL"}: ${String(payload.feedback)}`,
                    );
                }
            }
            if (event.type === "node:end" && event.nodeId === "panels"){
                console.log("[comic] ForEach finished");
            }
        },
    }).done;

    if (result.status !== "completed"){
        throw result.error ?? new Error(`comic pipeline ended with ${result.status}`);
    }

    const saved = await saveComic(runtime, result, events, topic);
    console.log("");
    console.log(`[comic] completed in ${String(Date.now() - started)}ms`);
    console.log(`[comic] panels: ${String(saved.panels.length)}`);
    for (const panel of saved.panels) console.log(`  ${panel}`);
    if (saved.sheet !== undefined) console.log(`[comic] sheet: ${saved.sheet}`);
    console.log(`[comic] states: ${saved.statePath}`);

    const review = reviewSummary(result);
    review.forEach((panel, index) =>{
        console.log(
            `[comic] panel ${String(index + 1)}: `
            + `${panel.failed === 0 ? "PASS" : "FAIL"} `
            + `attempts=${String(panel.attempts)}`,
        );
    });
    if (review.some((panel) => panel.failed > 0)){
        console.error("[comic] completed with panels still failing review");
        process.exitCode = 1;
    }
    if (saved.panels.length !== 4){
        throw new Error(`expected 4 panel images, got ${String(saved.panels.length)}`);
    }
}

await main();
