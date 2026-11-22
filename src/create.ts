import { Session, SessionHistory } from "./session/session";
import type { SessionHostOptions } from "./session/session";
import type { AttachmentFileManager } from "./session/attachment-manager";
import type { ChatProvider } from "./session/protocol";
import type { SessionRuntimeOptions } from "./session/type";

/** 创建一条全新的会话
 *
 * 上层对象负责长期维护 AIProvider、AttachmentFileManager 和运行时选项；
 * 这里只负责组装一个空历史的 Session，不恢复任何已有会话。
 *
 * @param provider 已构造好的对话 Provider（必须同时实现 ChatCapability）
 * @param attachmentManager 已构造好的附件管理器；省略表示不使用附件
 * @param runtimeOptions 运行时选项；省略时由 Session 在首次运行前向 Provider 询问默认模型，
 *                       think / thinkingLv 等未设置项保持 Provider 默认
 * @param hostOptions Session 级 host 内置工具注册选项；省略时保持旧行为
 * @returns 新的 Session（history 为空的新会话）
 */
export function createNewSession(
    provider: ChatProvider,
    attachmentManager?: AttachmentFileManager,
    runtimeOptions?: SessionRuntimeOptions,
    hostOptions?: SessionHostOptions,
): Session{
    return new Session(
        provider,
        new SessionHistory(),
        runtimeOptions,
        attachmentManager,
        hostOptions,
    );
}
