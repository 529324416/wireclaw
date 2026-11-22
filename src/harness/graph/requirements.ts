import { HarnessError, HarnessErrorCode } from "../base/error";
import type {
    NodeRequirement,
    RequirementCatalog,
} from "./type";

export type MissingRequirement = {
    code: HarnessErrorCode;
    message: string;
    requirement: NodeRequirement;
    nodeId?: string;
};

/** 返回第一个缺失依赖；catalog 中未提供的类别按“无法满足”处理 */
export function findMissingRequirement(
    requirements: readonly NodeRequirement[],
    catalog: RequirementCatalog,
    nodeId?: string,
): MissingRequirement | undefined{
    for (const requirement of requirements){
        switch (requirement.kind){
            case "tool":
                if (!(catalog.tools ?? []).includes(requirement.name)){
                    return missing(
                        HarnessErrorCode.MissingToolDependency,
                        `Node requires tool "${requirement.name}", but it is not available`,
                        requirement,
                        nodeId,
                    );
                }
                break;
            case "provider":
                if (!(catalog.providers ?? []).includes(requirement.providerId)){
                    return missing(
                        HarnessErrorCode.MissingProviderDependency,
                        `Node requires provider "${requirement.providerId}", but it is not available`,
                        requirement,
                        nodeId,
                    );
                }
                break;
            case "model":
                if (!(catalog.models ?? []).some((model) =>
                    model.providerId === requirement.providerId
                    && model.modelId === requirement.modelId)){
                    return missing(
                        HarnessErrorCode.MissingModelDependency,
                        `Node requires model "${requirement.providerId}/${requirement.modelId}", but it is not available`,
                        requirement,
                        nodeId,
                    );
                }
                break;
            case "parameter":
                if (!(catalog.parameters ?? []).includes(requirement.name)){
                    return missing(
                        HarnessErrorCode.MissingParameterDependency,
                        `Node requires parameter "${requirement.name}", but it is not available`,
                        requirement,
                        nodeId,
                    );
                }
                break;
            default:
                break;
        }
    }

    return undefined;
}

export function assertRequirementsSatisfied(
    requirements: readonly NodeRequirement[],
    catalog: RequirementCatalog,
    options: { nodeId?: string } = {},
): void{
    const missing = findMissingRequirement(requirements, catalog, options.nodeId);
    if (missing === undefined) return;

    throw new HarnessError(missing.code, missing.message, {
        nodeId: missing.nodeId,
    });
}

function missing(
    code: HarnessErrorCode,
    message: string,
    requirement: NodeRequirement,
    nodeId?: string,
): MissingRequirement{
    return { code, message, requirement, nodeId };
}
