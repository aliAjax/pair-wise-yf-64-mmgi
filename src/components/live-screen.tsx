import { component$ } from '@builder.io/qwik';
import type { ConferenceState } from '../relay/model';
import {
  chainSegments,
  isRelayCurrent,
  isSubtitleLive,
  liveSubtitlesForChain,
  speechById
} from '../relay/model';

// 大屏字幕：只播「当前发言 + 链 active + 字幕为当前版本」的分段。
// 中间段没确认前不出字幕；发言/原文一变，旧字幕立即从大屏撤下。
export const LiveScreen = component$<{ state: ConferenceState }>(({ state }) => {
  const current = state.speechQueue.find(
    (s) => s.roomId === state.activeRoomId && s.status === 'speaking'
  );
  const chains = current
    ? state.relayChains.filter(
        (c) => c.speechId === current.id && c.roomId === state.activeRoomId && c.status !== 'archived'
      )
    : [];

  return (
    <section class={`live-screen ${state.lowLatency ? 'low-latency' : ''}`}>
      <div class="live-head">
        <div>
          <span class="pill">大屏 · 实时字幕</span>
          {current ? (
            <h2>
              {current.speaker}
              <span class="live-langs">
                {current.language}
                {current.relayLanguage ? ` → ${current.relayLanguage}` : ''} → 目标语种
              </span>
            </h2>
          ) : (
            <h2>当前没有发言中的代表</h2>
          )}
        </div>
        {current && (
          <div class="live-chain-meta">
            {chains.length === 0 && <span class="pill">未建立接力链</span>}
            {chains.map((c) => (
              <span class={`pill chain-${c.status}`} key={c.id}>
                {c.targetLanguage} · {c.status === 'recovering' ? '接力恢复中' : '直播中'} · 断点 #{c.checkpoint}
              </span>
            ))}
          </div>
        )}
      </div>

      {!current && <p class="live-empty">等待发言开始……</p>}

      {current && chains.length === 0 && (
        <p class="live-empty">该发言尚未建立接力链，下游无字幕。请在下方控制台建立接力链。</p>
      )}

      {current &&
        chains.map((chain) => {
          const segs = chainSegments(state, chain.id);
          const live = liveSubtitlesForChain(state, chain.id);
          const waiting = segs.filter((s) => !isRelayCurrent(s) && s.relayVersion === s.sourceVersion);
          const invalid = segs.filter(
            (s) => s.relayVersion > 0 && s.relayVersion < s.sourceVersion
          );
          const recovering = chain.status === 'recovering';
          return (
            <div class="live-channel" key={chain.id}>
              <div class="live-channel-head">
                <b>{chain.targetLanguage}</b>
                <span class="live-path">
                  {chain.sourceLanguage} → {chain.relayLanguage} → {chain.targetLanguage}
                </span>
                {recovering && <span class="pill chain-recovering">接力恢复中 · 断点 #{chain.checkpoint}</span>}
              </div>

              {recovering && (
                <p class="live-banner">
                  接力中断后从断点 #{chain.checkpoint} 恢复：已确认分段保留，仅补未确认部分，不重放整条链。
                </p>
              )}

              <div class="live-lines">
                {live.length === 0 && !recovering && (
                  <p class="live-wait">等待中间段确认，下游暂不出字幕……</p>
                )}
                {live.length === 0 && recovering && (
                  <p class="live-wait">恢复中：已确认分段继续播出，未确认分段重译后再上屏。</p>
                )}
                {live.map((seg) => (
                  <div class="live-line" key={seg.id}>
                    <span class="live-seq">#{seg.sequence}</span>
                    <p>{seg.targetText}</p>
                  </div>
                ))}
              </div>

              {waiting.length > 0 && (
                <p class="live-wait">
                  {waiting.length} 个分段已提交中间译文、等待确认，确认后下游才出字幕。
                </p>
              )}
              {invalid.length > 0 && (
                <p class="live-invalid">
                  {invalid.length} 个分段因原文修正已失效，等待重算（中间译文 → 字幕）。
                </p>
              )}
            </div>
          );
        })}
    </section>
  );
});
