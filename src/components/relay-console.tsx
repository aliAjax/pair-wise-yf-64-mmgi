import { $, component$, useSignal } from '@builder.io/qwik';
import type { ConferenceState, RelayChain, RelaySegment } from '../relay/model';
import {
  appendSourceSegment,
  chainSegments,
  confirmRelay,
  createRelayChain,
  isRelayCurrent,
  isSubtitleLive,
  publishTarget,
  recoverFromRelayFailure,
  reviseSource,
  submitRelay
} from '../relay/model';

// 分段状态徽标
function segBadge(seg: RelaySegment) {
  if (isSubtitleLive(seg)) return { text: '已上屏', cls: 'seg-live' };
  if (seg.relayVersion > 0 && seg.relayVersion < seg.sourceVersion) return { text: '已失效 · 待重算', cls: 'seg-invalid' };
  if (isRelayCurrent(seg)) return { text: '已确认 · 可发布', cls: 'seg-confirmed' };
  if (seg.relayVersion > 0) return { text: '中间段待确认', cls: 'seg-pending' };
  return { text: '待译', cls: 'seg-source' };
}

const SegmentRow = component$<{ state: ConferenceState; chain: RelayChain; seg: RelaySegment }>(
  ({ state, chain, seg }) => {
    const relayInput = useSignal(seg.relayText);
    const targetInput = useSignal(seg.targetText);
    const reviseOpen = useSignal(false);
    const reviseInput = useSignal(seg.sourceText);
    const badge = segBadge(seg);

    const submitRelay$ = $(() => {
      submitRelay(state, seg.id, relayInput.value);
    });
    const confirm$ = $(() => confirmRelay(state, seg.id));
    const publish$ = $(() => {
      publishTarget(state, seg.id, targetInput.value);
    });
    const revise$ = $(() => {
      reviseSource(state, seg.id, reviseInput.value);
      reviseOpen.value = false;
    });

    const relayStale = seg.relayVersion > 0 && seg.relayVersion < seg.sourceVersion;
    const canPublish = isRelayCurrent(seg) && !isSubtitleLive(seg);
    const live = isSubtitleLive(seg);

    return (
      <div class={`seg-row ${badge.cls}`}>
        <div class="seg-head">
          <span class="seg-seq">#{seg.sequence}</span>
          <span class={`pill ${badge.cls}`}>{badge.text}</span>
          <span class="seg-versions">
            原文 v{seg.sourceVersion}
            {seg.relayVersion > 0 && <> · 中间 v{seg.relayVersion}{seg.relayConfirmed ? '✓' : ''}</>}
            {seg.targetVersion > 0 && <> · 字幕 v{seg.targetVersion}</>}
          </span>
        </div>

        <div class="seg-source">
          <small>原文（{chain.sourceLanguage}）</small>
          <p>{seg.sourceText}</p>
          {live && (
            <button class="link-btn" onClick$={() => (reviseOpen.value = !reviseOpen.value)}>
              修正原文（失效重算）
            </button>
          )}
          {reviseOpen.value && (
            <div class="seg-revise">
              <textarea
                rows={2}
                value={reviseInput.value}
                onInput$={(e) => (reviseInput.value = (e.target as HTMLTextAreaElement).value)}
              />
              <button onClick$={revise$}>提交修正 · 下游字幕立即失效</button>
            </div>
          )}
        </div>

        {/* 中间段 */}
        <div class="seg-relay">
          <small>
            中间译文（{chain.relayLanguage}）
            {seg.relayInterpreter ? ` · ${seg.relayInterpreter}` : ''}
          </small>
          {seg.relayVersion === 0 && (
            <div class="seg-input">
              <textarea
                rows={2}
                value={relayInput.value}
                onInput$={(e) => (relayInput.value = (e.target as HTMLTextAreaElement).value)}
                placeholder="接力译员提交中间译文（提交后未确认，下游不出字幕）"
              />
              <button onClick$={submitRelay$}>提交中间译文</button>
            </div>
          )}
          {seg.relayVersion > 0 && (
            <>
              <p class={relayStale ? 'strike' : ''}>{seg.relayText}</p>
              {relayStale && (
                <div class="seg-input">
                  <textarea
                    rows={2}
                    value={relayInput.value}
                    onInput$={(e) => (relayInput.value = (e.target as HTMLTextAreaElement).value)}
                    placeholder="原文已修正，需重新提交中间译文"
                  />
                  <button onClick$={submitRelay$}>重新提交中间译文（重算）</button>
                </div>
              )}
              {!relayStale && !seg.relayConfirmed && (
                <button class="confirm-btn" onClick$={confirm$} disabled={!seg.relayText.trim()}>
                  确认中间段 · 建立断点（下游可出字幕）
                </button>
              )}
              {!relayStale && seg.relayConfirmed && !live && (
                <p class="seg-note">中间段已确认（断点 #{chain.checkpoint}），等待目标语种发布字幕。</p>
              )}
            </>
          )}
        </div>

        {/* 目标段 */}
        <div class="seg-target">
          <small>
            目标字幕（{chain.targetLanguage}）
            {seg.targetInterpreter ? ` · ${seg.targetInterpreter}` : ''}
          </small>
          {live && <p class="seg-live-text">{seg.targetText}</p>}
          {canPublish && (
            <div class="seg-input">
              <textarea
                rows={2}
                value={targetInput.value}
                onInput$={(e) => (targetInput.value = (e.target as HTMLTextAreaElement).value)}
                placeholder="中间段已确认，可发布字幕"
              />
              <button onClick$={publish$}>发布字幕（上屏）</button>
            </div>
          )}
          {!canPublish && !live && seg.relayVersion > 0 && !relayStale && (
            <p class="seg-note warn">中间段未确认，下游不出字幕。</p>
          )}
          {!canPublish && !live && relayStale && (
            <p class="seg-note warn">中间译文已过期，重算后才能发布字幕。</p>
          )}
          {seg.relayVersion === 0 && <p class="seg-note">待接力译员提交中间译文。</p>}
        </div>
      </div>
    );
  }
);

const SegmentPipeline = component$<{ state: ConferenceState; chain: RelayChain }>(({ state, chain }) => {
  const sourceInput = useSignal('');
  const segs = chainSegments(state, chain.id);
  const confirmed = segs.filter((s) => isRelayCurrent(s)).length;

  const append$ = $(() => {
    appendSourceSegment(state, chain.id, sourceInput.value);
    sourceInput.value = '';
  });

  return (
    <div class="pipeline">
      <div class="pipeline-progress">
        断点进度：已确认 {confirmed}/{segs.length} 段 · 断点 #{chain.checkpoint}
        {chain.status === 'recovering' && <span class="pill chain-recovering">接力恢复中</span>}
      </div>

      {segs.map((seg) => (
        <SegmentRow key={seg.id} state={state} chain={chain} seg={seg} />
      ))}

      <div class="seg-input append">
        <textarea
          rows={2}
          value={sourceInput.value}
          onInput$={(e) => (sourceInput.value = (e.target as HTMLTextAreaElement).value)}
          placeholder="追加原文分段（源语言）"
        />
        <button onClick$={append$} disabled={!sourceInput.value.trim()}>
          追加原文分段
        </button>
      </div>
    </div>
  );
});

export const RelayConsole = component$<{ state: ConferenceState }>(({ state }) => {
  const current = state.speechQueue.find(
    (s) => s.roomId === state.activeRoomId && s.status === 'speaking'
  );
  const chains = current
    ? state.relayChains.filter(
        (c) => c.speechId === current.id && c.roomId === state.activeRoomId && c.status !== 'archived'
      )
    : [];
  const selectedId = useSignal<string>(chains[0]?.id ?? '');
  const targetLang = useSignal('中文');
  const relayLang = useSignal(current?.relayLanguage || '英语');

  const roomChannels = state.channels.filter((c) => c.roomId === state.activeRoomId);
  const targetOptions = roomChannels.map((c) => c.language).filter((v, i, a) => a.indexOf(v) === i);
  const relayOptions = roomChannels
    .filter((c) => c.role === 'relay')
    .map((c) => c.language)
    .filter((v, i, a) => a.indexOf(v) === i);

  const selected = chains.find((c) => c.id === selectedId.value) ?? chains[0];

  const create$ = $(() => {
    if (!current) return;
    createRelayChain(state, current.id, targetLang.value, relayLang.value);
    const next = state.relayChains.find(
      (c) => c.speechId === current.id && c.targetLanguage === targetLang.value
    );
    if (next) selectedId.value = next.id;
  });

  const interrupt$ = $(() => {
    if (selected) recoverFromRelayFailure(state, selected.relayChannelId);
  });

  return (
    <article class="panel relay-console">
      <div class="relay-console-head">
        <h2>接力链控制台</h2>
        {current && (
          <span class="pill">
            {current.speaker} · {current.language}
            {current.relayLanguage ? ` → ${current.relayLanguage}` : ''} → 目标语种
          </span>
        )}
      </div>

      {!current && <p class="live-empty">当前没有发言中的代表，无法建立接力链。</p>}

      {current && (
        <div class="relay-create">
          <select value={relayLang.value} onChange$={(e) => (relayLang.value = (e.target as HTMLSelectElement).value)}>
            {relayOptions.length === 0 && <option value={relayLang.value}>{`${relayLang.value}（无接力频道）`}</option>}
            {relayOptions.map((l) => (
              <option key={l} value={l}>{`中间语言 · ${l}`}</option>
            ))}
          </select>
          <span class="relay-arrow">→</span>
          <select value={targetLang.value} onChange$={(e) => (targetLang.value = (e.target as HTMLSelectElement).value)}>
            {targetOptions.map((l) => (
              <option key={l} value={l}>{`目标语言 · ${l}`}</option>
            ))}
          </select>
          <button class="secondary" onClick$={create$}>建立接力链</button>
        </div>
      )}

      {chains.length === 0 && current && (
        <p class="live-empty">尚未建立接力链。小语种发言请先建立「源语言 → 中间语言 → 目标语言」接力链。</p>
      )}

      <div class="relay-chain-tabs">
        {chains.map((c) => (
          <button
            key={c.id}
            class={`tab ${selected?.id === c.id ? 'active' : ''} ${c.status === 'recovering' ? 'tab-recovering' : ''}`}
            onClick$={() => (selectedId.value = c.id)}
          >
            {c.targetLanguage} · {c.relayLanguage}接力
            <span class="tab-checkpoint">断点 #{c.checkpoint}</span>
          </button>
        ))}
      </div>

      {selected && (
        <div class="relay-detail">
          <div class="relay-detail-head">
            <div>
              <b>{selected.sourceLanguage} → {selected.relayLanguage} → {selected.targetLanguage}</b>
              <div class="relay-interpreters">
                接力频道：{state.channels.find((c) => c.id === selected.relayChannelId)?.interpreter}
                {' · '}目标频道：{state.channels.find((c) => c.id === selected.targetChannelId)?.interpreter}
              </div>
            </div>
            <button class="danger" onClick$={interrupt$}>模拟接力中断（换人/掉线）</button>
          </div>
          <SegmentPipeline state={state} chain={selected} />
        </div>
      )}
    </article>
  );
});
