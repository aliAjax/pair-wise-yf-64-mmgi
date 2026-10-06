import { component$, $, useSignal, useStore, useVisibleTask$, type Signal } from '@builder.io/qwik';
import type { DocumentHead } from '@builder.io/qwik-city';
import {
  createChain, appendSource, reviseSource, reissueSpeech, submitDraft, correctDraft,
  confirmSegment, setChannelOnline, handoff, onAirCaptions, getSeg, STATUS_LABEL,
  type RelayChain, type Stage, type RelaySegment
} from '~/relay/relay-chain';

const STORAGE_KEY = 'conference-relay-v1';

function seedChain(): RelayChain {
  const chain = createChain({
    speech: '肯尼亚代表关于适应性融资的发言',
    roomId: 'hall-a',
    sourceLang: '斯瓦希里语',
    pivotLang: '英语',
    targetLang: '中文',
    pivotInterpreter: 'Ada Okafor',
    targetInterpreter: '周雨'
  });
  appendSource(chain, 'Mfuko wa kukabiliana na mabadiliko ya hali ya hewa hautoshi.');
  submitDraft(chain, 'pivot', 1, 'The adaptation fund is far from sufficient.');
  confirmSegment(chain, 'pivot', 1);
  submitDraft(chain, 'target', 1, '适应资金远远不够。');
  confirmSegment(chain, 'target', 1);
  appendSource(chain, 'Tunahitaji nchi zilizoendelea kutekeleza ahadi zao.');
  submitDraft(chain, 'pivot', 2, 'We need developed countries to honor their pledges.');
  return chain;
}

function loadChain(): RelayChain {
  if (typeof localStorage === 'undefined') return seedChain();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as RelayChain;
  } catch { /* fall through */ }
  return seedChain();
}

const STATUS_CLASS: Record<RelaySegment['status'], string> = {
  pending: 'st-pending',
  draft: 'st-draft',
  confirmed: 'st-confirmed',
  blocked: 'st-blocked',
  stale: 'st-stale',
  recovering: 'st-recovering'
};

/** 一段译文的草稿编辑格：提交草稿 / 确认 / 已确认后的订正 */
const DraftCell = component$(
  ({ chain, stage, seq, error }: { chain: RelayChain; stage: Stage; seq: number; error: Signal<string> }) => {
    const seg = getSeg(chain, stage, seq)!;
    const text = useSignal(seg.text);
    const run = $(async (fn: () => void) => {
      try { fn(); error.value = ''; } catch (e) { error.value = (e as Error).message; }
    });
    const actionable = seg.status === 'pending' || seg.status === 'stale' || seg.status === 'draft';
    return (
      <div class="draft-cell">
        {seg.status === 'blocked' && <div class="lock">🔒 中间段未确认<br />目标语不出字幕</div>}
        {seg.status === 'confirmed' && (
          <div class="frozen-text">
            <div class="seg-text">{seg.text}</div>
            <div class="seg-meta">译员 {seg.interpreter} · {new Date(seg.confirmedAt!).toLocaleTimeString()} 冻结</div>
            <button class="link-btn" onClick$={() => run(() => correctDraft(chain, stage, seq, text.value))}>提出订正（下游字幕将失效重算）</button>
          </div>
        )}
        {seg.status === 'recovering' && <div class="lock">⏸ 断点待补译<br />恢复后仅需补本段</div>}
        {actionable && (
          <>
            <textarea
              rows={2}
              value={text.value}
              onInput$={(e) => (text.value = (e.target as HTMLTextAreaElement).value)}
              placeholder={`译为${seg.lang}，提交后需确认才对下游可见`}
            />
            <div class="seg-actions">
              <button class="secondary" onClick$={() => run(() => { submitDraft(chain, stage, seq, text.value); })}>
                {seg.status === 'stale' ? '按新版本重译' : '提交草稿'}
              </button>
              <button disabled={seg.status !== 'draft'} onClick$={() => run(() => confirmSegment(chain, stage, seq))}>
                确认并{stage === 'pivot' ? '放行下游' : '播出字幕'}
              </button>
            </div>
          </>
        )}
      </div>
    );
  }
);

/** 源语段：显示文本/版本，允许修订（修订即作废下游） */
const SourceCell = component$(({ chain, seq }: { chain: RelayChain; seq: number }) => {
  const seg = getSeg(chain, 'source', seq)!;
  const editing = useSignal(false);
  const text = useSignal(seg.text);
  return (
    <div class="draft-cell">
      <div class="seg-text">{seg.text}</div>
      {!editing.value && <button class="link-btn" onClick$={() => { text.value = seg.text; editing.value = true; }}>发言修订（下游字幕立即失效）</button>}
      {editing.value && (
        <>
          <textarea rows={2} value={text.value} onInput$={(e) => (text.value = (e.target as HTMLTextAreaElement).value)} />
          <div class="seg-actions">
            <button class="secondary" onClick$={() => (editing.value = false)}>取消</button>
            <button
              onClick$={() => {
                if (text.value.trim()) reviseSource(chain, seq, text.value);
                editing.value = false;
              }}
            >
              提交修订 v{seg.version + 1}
            </button>
          </div>
        </>
      )}
      <div class="seg-meta">源文 v{seg.version}</div>
    </div>
  );
});

export default component$(() => {
  const chain = useStore<RelayChain>(loadChain(), { deep: true });
  const error = useSignal('');

  const newSource = useSignal('');
  const setup = useStore({ speech: '', sourceLang: '斯瓦希里语', pivotLang: '英语', targetLang: '中文', pivotInterpreter: '', targetInterpreter: '' });
  const pivotHandoff = useSignal('');
  const targetHandoff = useSignal('');

  useVisibleTask$(({ track }) => {
    track(() => chain);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(chain));
  });

  const seqs = [...new Set(chain.segments.map((s) => s.seq))].sort((a, b) => a - b);
  const onAir = onAirCaptions(chain);
  const lastAiredSeq = onAir.length ? onAir[onAir.length - 1].seq : 0;

  const createNew$ = $(() => {
    if (!setup.speech.trim() || !setup.pivotInterpreter.trim() || !setup.targetInterpreter.trim()) {
      error.value = '请填写发言名称与两名译员';
      return;
    }
    const fresh = createChain({
      speech: setup.speech, roomId: 'hall-a',
      sourceLang: setup.sourceLang, pivotLang: setup.pivotLang, targetLang: setup.targetLang,
      pivotInterpreter: setup.pivotInterpreter, targetInterpreter: setup.targetInterpreter
    });
    Object.assign(chain, fresh);
    error.value = '';
  });

  return (
    <main class="conference-shell relay-shell">
      <header class="hero">
        <div>
          <span class="pill">同传接力链</span>
          <h1>源语言 → 英语接一段 → 目标语言</h1>
          <p>
            {chain.speech} · <b>{chain.sourceLang} → {chain.pivotLang} → {chain.targetLang}</b> · 发言版本 sourceRev {chain.sourceRev}
          </p>
        </div>
        <div class="chain-status">
          <span class={`pill ${chain.status === 'failed' ? 'pill-danger' : 'pill-live'}`}>
            {chain.status === 'failed' ? `接力中断：${chain.failReason}` : '● 链路直播中'}
          </span>
          {chain.breakpoint && (
            <span class="pill pill-warn">断点 {chain.breakpoint.stage === 'pivot' ? chain.pivotLang : chain.targetLang} 第 {chain.breakpoint.seq} 段</span>
          )}
          <a class="back-link" href="/">← 返回队列控制台</a>
        </div>
      </header>

      {error.value && <div class="error-bar" onClick$={() => (error.value = '')}>⚠ {error.value}（点击关闭）</div>}

      <section class="grid">
        {/* 左：三泳道 */}
        <article class="panel">
          <div class="lanes-head">
            <h2>接力泳道（{seqs.length} 段）</h2>
            <div class="append-box">
              <input
                placeholder="新增一段源语发言（回车追加）"
                value={newSource.value}
                onInput$={(e) => (newSource.value = (e.target as HTMLInputElement).value)}
                onKeyUp$={(e) => {
                  if (e.key === 'Enter' && newSource.value.trim()) {
                    appendSource(chain, newSource.value);
                    newSource.value = '';
                  }
                }}
              />
              <button
                onClick$={() => {
                  if (newSource.value.trim()) { appendSource(chain, newSource.value); newSource.value = ''; }
                }}
              >
                追加发言
              </button>
              <button class="danger" onClick$={() => reissueSpeech(chain)} title="讲话人换稿：所有下游字幕一次性撤下">整条换稿</button>
            </div>
          </div>

          <div class="lane-labels">
            <div class="lane-label">源语言 · {chain.sourceLang}</div>
            <div class="lane-label">中间语言 · {chain.pivotLang}</div>
            <div class="lane-label">目标语言 · {chain.targetLang}（下游字幕）</div>
          </div>

          {seqs.map((seq) => {
            const source = getSeg(chain, 'source', seq)!;
            const pivot = getSeg(chain, 'pivot', seq)!;
            const target = getSeg(chain, 'target', seq)!;
            const afterGap = onAir.length > 0 && seq > lastAiredSeq;
            return (
              <div class="seg-row" key={seq}>
                <div class="seg-index">#{seq}</div>
                <div class="seg-cell">
                  <SourceCell chain={chain} seq={seq} />
                </div>
                <div class="arrow">{pivot.status === 'confirmed' ? '✅' : pivot.status === 'stale' ? '↻' : '→'}</div>
                <div class={`seg-cell ${STATUS_CLASS[pivot.status]}`}>
                  <span class={`status-pill ${STATUS_CLASS[pivot.status]}`}>{STATUS_LABEL[pivot.status]} · v{pivot.version}{pivot.status === 'draft' ? ` / 上游 v${pivot.basedOnVersion}` : ''}</span>
                  <DraftCell chain={chain} stage="pivot" seq={seq} error={error} />
                </div>
                <div class="arrow">{target.status === 'confirmed' ? '✅' : target.status === 'blocked' ? '🔒' : target.status === 'stale' ? '↻' : '→'}</div>
                <div class={`seg-cell ${STATUS_CLASS[target.status]} ${afterGap ? 'behind-air' : ''}`}>
                  <span class={`status-pill ${STATUS_CLASS[target.status]}`}>{STATUS_LABEL[target.status]} · v{target.version}</span>
                  <DraftCell chain={chain} stage="target" seq={seq} error={error} />
                </div>
              </div>
            );
          })}
          {seqs.length === 0 && <p class="empty-hint">还没有发言段，在上方输入第一条源语发言。</p>}
        </article>

        {/* 右：播出屏 + 频道/译员 + 时间线 */}
        <aside class="side">
          <article class="panel onair-panel">
            <h2>📺 下游大屏实际在播</h2>
            <div class="onair-screen">
              {onAir.length === 0 && <div class="onair-blank">（暂无已确认字幕）</div>}
              {onAir.map((s) => (
                <div class="onair-line" key={s.seq}>
                  <span class="onair-seq">{s.seq}</span>
                  <span class={chain.segments.some((x) => x.stage === 'target' && x.seq === s.seq && x.airedText === null) ? 'caption-gone' : ''}>{s.airedText}</span>
                </div>
              ))}
            </div>
            <p class="rule-note">中间段确认前此屏不出字；发言一变，未在播的旧字幕立即撤下并标“已失效·待重算”。</p>
          </article>

          <article class="panel">
            <h2>频道与译员</h2>
            {(['pivot', 'target'] as const).map((stage) => {
              const ch = chain.channels[stage];
              return (
                <div class="channel-row" key={stage}>
                  <div>
                    <b>{stage === 'pivot' ? '中间岗' : '目标岗'} · {ch.language}</b>
                    <div class="seg-meta">译员：{ch.interpreter} · {ch.online ? '频道在线' : '频道掉线'}</div>
                  </div>
                  <div class="channel-actions">
                    <button
                      class={ch.online ? 'danger' : ''}
                      onClick$={() => setChannelOnline(chain, stage, !ch.online)}
                    >
                      {ch.online ? '模拟掉线' : '恢复接通（断点续译）'}
                    </button>
                    <div class="handoff-box">
                      <input placeholder="新译员姓名" value={stage === 'pivot' ? pivotHandoff.value : targetHandoff.value}
                        onInput$={(e) => {
                          const v = (e.target as HTMLInputElement).value;
                          if (stage === 'pivot') pivotHandoff.value = v; else targetHandoff.value = v;
                        }} />
                      <button class="secondary" onClick$={() => {
                        const name = stage === 'pivot' ? pivotHandoff.value : targetHandoff.value;
                        if (name.trim()) { handoff(chain, stage, name.trim()); if (stage === 'pivot') pivotHandoff.value = ''; else targetHandoff.value = ''; }
                      }}>换人续接</button>
                    </div>
                  </div>
                </div>
              );
            })}
            {chain.status === 'failed' && (
              <button class="recover-btn" onClick$={() => {
                if (chain.breakpoint) setChannelOnline(chain, chain.breakpoint.stage, true);
              }}>
                从断点 {chain.breakpoint && `#${chain.breakpoint.seq}`} 恢复（已确认段不重放）
              </button>
            )}
          </article>

          <article class="panel">
            <h2>新建接力链</h2>
            <div class="setup-grid">
              <input placeholder="发言名称" value={setup.speech} onInput$={(e) => (setup.speech = (e.target as HTMLInputElement).value)} />
              <input placeholder="源语言" value={setup.sourceLang} onInput$={(e) => (setup.sourceLang = (e.target as HTMLInputElement).value)} />
              <input placeholder="中间语言" value={setup.pivotLang} onInput$={(e) => (setup.pivotLang = (e.target as HTMLInputElement).value)} />
              <input placeholder="目标语言" value={setup.targetLang} onInput$={(e) => (setup.targetLang = (e.target as HTMLInputElement).value)} />
              <input placeholder="中间岗译员" value={setup.pivotInterpreter} onInput$={(e) => (setup.pivotInterpreter = (e.target as HTMLInputElement).value)} />
              <input placeholder="目标岗译员" value={setup.targetInterpreter} onInput$={(e) => (setup.targetInterpreter = (e.target as HTMLInputElement).value)} />
            </div>
            <button onClick$={createNew$}>建立新链（清空当前）</button>
          </article>

          <article class="panel">
            <h2>接力事件时间线</h2>
            <div class="event-log">
              {chain.events.slice(0, 12).map((ev) => (
                <div class={`event ev-${ev.kind}`} key={ev.id}>
                  <small>{new Date(ev.at).toLocaleTimeString()}</small>
                  <div>{ev.message}</div>
                </div>
              ))}
            </div>
          </article>
        </aside>
      </section>
    </main>
  );
});

export const head: DocumentHead = {
  title: '同传接力链控制台',
  meta: [{ name: 'description', content: '源语—中间语—目标语接力：确认门控、版本失效与断点恢复' }]
};
