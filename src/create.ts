import { Session, SessionHistory } from "./session/session";
import type { AttachmentFileManager } from "./session/attachment-manager";
import type { LLMProvider } from "./session/protocol";
import type { SessionRuntimeOptions } from "./session/type";

/** 创建一条全新的会话
 *
 * 上层对象负责长期维护 LLMProvider、AttachmentFileManager 和运行时选项；
 * 这里只负责组装一个空历史的 Session，不恢复任何已有会话。
 *
 * @param llm 已构造好的 LLM Provider（每个平台协议一个实例）
 * @param attachmentManager 已构造好的附件管理器；省略表示不使用附件
 * @param runtimeOptions 运行时选项；省略时由 Session 在首次运行前向 Provider 询问默认模型，
 *                       think / thinkingLv 等未设置项保持 Provider 默认
 * @returns 新的 Session（history 为空的新会话）
 */
export function createNewSession(
    llm: LLMProvider,
    attachmentManager?: AttachmentFileManager,
    runtimeOptions?: SessionRuntimeOptions,
): Session{
    return new Session(
        llm,
        new SessionHistory(),
        runtimeOptions,
        attachmentManager,
    );
}
