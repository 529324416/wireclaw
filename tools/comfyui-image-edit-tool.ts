import { ComfyUIImageToolProvider } from "./comfyui-image-tool";
import type { ComfyUIImageToolOptions } from "./comfyui-image-tool";

/** 修图工具选项：与生图工具相同，但必须提供至少一张参考图 */
export type ComfyUIImageEditToolOptions = Omit<
    ComfyUIImageToolOptions,
    "id" | "name" | "description" | "toolName" | "toolTitle" | "toolDescription" | "minReferences"
> & {
    id?: string;
    name?: string;
    description?: string;
    toolName?: string;
    toolTitle?: string;
    toolDescription?: string;
};

/** ComfyUI Qwen-Image 修图工具
 *
 * 与生图工具共用工作流执行逻辑，但强制 references >= 1；
 * 有 size 时通过工作流里的 ComfySwitchNode 切到 EmptyLatent，让尺寸参数生效。
 */
export class ComfyUIImageEditToolProvider extends ComfyUIImageToolProvider {

    constructor(options: ComfyUIImageEditToolOptions){
        super({
            ...options,
            id: options.id ?? "comfyui-edit",
            name: options.name ?? "ComfyUI Image Edit",
            description: options.description ?? "ComfyUI Qwen-Image 参考图编辑工具",
            toolName: options.toolName ?? "editImage",
            toolTitle: options.toolTitle ?? "Edit Image",
            toolDescription: options.toolDescription
                ?? "基于 1~16 张参考图调用本地 ComfyUI Qwen-Image 修图工作流；必须提供 references。",
            minReferences: 1,
        });
    }
}
