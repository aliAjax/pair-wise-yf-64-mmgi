import { $, component$, useSignal, useStore, useVisibleTask$ } from '@builder.io/qwik';
import { Progress } from '@qwik-ui/headless';
import { useForm, zodForm$ } from '@modular-forms/qwik';
import { useSpeakLocale } from 'qwik-speak';
import { z } from 'zod';
import type { DocumentHead } from '@builder.io/qwik-city';
import { LiveScreen } from '../components/live-screen';
import { RelayConsole } from '../components/relay-console';
import { seed } from '../relay/seed';
import {
  archiveChainsOfSpeech,
  recoverFromRelayFailure,
  type Channel,
  type ConferenceState,
  type SpeechStatus
} from '../relay/model';

const STORAGE_KEY = 'conference-interpretation-v2';

function readState(): ConferenceState {
  if (typeof localStorage === 'undefined') return structuredClone(seed);
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(seed);
    const parsed = JSON.parse(raw) as Partial<ConferenceState>;
    return {
      ...structuredClone(seed),
      ...parsed,
      rooms: parsed.rooms ?? seed.rooms,
      speechQueue: parsed.speechQueue ?? seed.speechQueue,
      channels: parsed.channels ?? seed.channels,
      terms: parsed.terms ?? seed.terms,
      captions: parsed.captions ?? seed.captions,
      audits: parsed.audits ?? seed.audits,
      relayChains: parsed.relayChains ?? seed.relayChains,
      relaySegments: parsed.relaySegments ?? seed.relaySegments
    };
  } catch {
    return structuredClone(seed);
  }
}

const queueSchema = z.object({
  speaker: z.string().min(2, '请输入发言人'),
  delegation: z.string().min(2, '请输入代表团'),
  language: z.string().min(2, '请输入源语言'),
  relayLanguage: z.string(),
  topic: z.string().min(3, '请输入议题'),
  plannedSeconds: z.coerce.number().min(60).max(3600)
});
type QueueForm = z.infer<typeof queueSchema>;

export default component$(() => {
  const locale = useSpeakLocale();
  const state = useStore<ConferenceState>(readState());
  const queueLoader = useSignal<QueueForm>({
    speaker: '',
    delegation: '',
    language: '英语',
    relayLanguage: '英语',
    topic: '',
    plannedSeconds: 300
  });
  const [queueForm, { Form: QueueFormEl, Field: QueueField }] = useForm<QueueForm>({
    loader: queueLoader,
    validate: zodForm$(queueSchema)
  });

  useVisibleTask$(({ track }) => {
    track(() => state);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  });

  const activeRoom = () => state.rooms.find((room) => room.id === state.activeRoomId) ?? state.rooms[0];
  const roomQueue = () => state.speechQueue.filter((item) => item.roomId === state.activeRoomId);
  const roomChannels = () => state.channels.filter((item) => item.roomId === state.activeRoomId);
  const currentSpeech = () => roomQueue().find((item) => item.status === 'speaking');

  const selectRoom$ = $((roomId: string) => {
    state.activeRoomId = roomId;
    state.audits.unshift({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      roomId,
      message: `切换到 ${state.rooms.find((room) => room.id === roomId)?.name}`
    });
  });

  // 发言状态切换：旧发言结束/跳过时，其接力链立即归档，大屏字幕失效
  const advanceSpeech$ = $((id: string, status: SpeechStatus) => {
    state.speechQueue = state.speechQueue.map((item) =>
      item.id === id ? { ...item, status, updatedAt: new Date().toISOString() } : item
    );
    if (status === 'speaking') {
      state.speechQueue = state.speechQueue.map((item) =>
        item.id !== id && item.roomId === state.activeRoomId && item.status === 'speaking'
          ? { ...item, status: 'done', updatedAt: new Date().toISOString() }
          : item
      );
    }
    if (status === 'done' || status === 'skipped') {
      archiveChainsOfSpeech(state, id);
    }
    if (status === 'speaking') {
      // 其他被置为 done 的发言也要归档接力链
      state.speechQueue
        .filter((item) => item.roomId === state.activeRoomId && item.status === 'done')
        .forEach((item) => archiveChainsOfSpeech(state, item.id));
    }
    state.audits.unshift({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      roomId: state.activeRoomId,
      message: `发言 ${id} 状态更新为 ${status}`
    });
  });

  const addSpeech$ = $((values: QueueForm) => {
    state.speechQueue.push({
      id: crypto.randomUUID(),
      roomId: state.activeRoomId,
      speaker: values.speaker,
      delegation: values.delegation,
      language: values.language,
      relayLanguage: values.relayLanguage,
      topic: values.topic,
      plannedSeconds: values.plannedSeconds,
      remainingSeconds: values.plannedSeconds,
      status: 'queued',
      updatedAt: new Date().toISOString()
    });
    state.audits.unshift({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      roomId: state.activeRoomId,
      message: `${values.speaker} 已加入发言队列（${values.language}${values.relayLanguage ? ` → ${values.relayLanguage} → 目标语种` : '，直接翻译'}）`
    });
  });

  // 频道交接：接力频道换人会触发接力链从断点恢复
  const handoff$ = $((channelId: string) => {
    state.channels = state.channels.map((channel) =>
      channel.id === channelId ? { ...channel, status: 'handoff' } : channel
    );
    state.audits.unshift({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      roomId: state.activeRoomId,
      message: `${channelId} 启动译员交接，原译文版本已冻结`
    });
  });

  const completeHandoff$ = $((channel: Channel, interpreter: string) => {
    state.channels = state.channels.map((c) =>
      c.id === channel.id
        ? { ...c, interpreter, status: 'active', health: Math.min(100, c.health + 2) }
        : c
    );
    state.audits.unshift({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      roomId: state.activeRoomId,
      message: `${interpreter} 接续 ${channel.language} 频道，后续字幕归属新译员`
    });
    if (channel.role === 'relay') {
      recoverFromRelayFailure(state, channel.id);
    }
  });

  // 频道掉线 / 恢复：掉线触发接力链从断点恢复
  const toggleOffline$ = $((channel: Channel) => {
    if (channel.status === 'offline') {
      state.channels = state.channels.map((c) =>
        c.id === channel.id ? { ...c, status: 'active', health: 90 } : c
      );
      state.audits.unshift({
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        roomId: state.activeRoomId,
        message: `${channel.language} 频道恢复上线`
      });
    } else {
      state.channels = state.channels.map((c) =>
        c.id === channel.id ? { ...c, status: 'offline', health: 0 } : c
      );
      state.audits.unshift({
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        roomId: state.activeRoomId,
        message: `${channel.language} 频道掉线，接力链从断点恢复`
      });
      if (channel.role === 'relay') {
        recoverFromRelayFailure(state, channel.id);
      }
    }
  });

  const approveTerm$ = $((id: string) => {
    state.terms = state.terms.map((term) => (term.id === id ? { ...term, approved: true } : term));
    state.audits.unshift({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      roomId: state.activeRoomId,
      message: `术语已批准：${state.terms.find((term) => term.id === id)?.phrase}`
    });
  });

  return (
    <main class={`conference-shell ${state.lowLatency ? 'low-latency' : ''}`}>
      <header class="hero">
        <div>
          <span class="pill">{locale.lang}</span>
          <h1>同声传译与发言队列</h1>
          <p>{activeRoom().name} · {activeRoom().topic}</p>
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          <select
            value={state.activeRoomId}
            onChange$={(event) => selectRoom$((event.target as HTMLSelectElement).value)}
          >
            {state.rooms.map((room) => (
              <option key={room.id} value={room.id}>{room.name}</option>
            ))}
          </select>
          <button class="secondary" onClick$={() => (state.lowLatency = !state.lowLatency)}>
            {state.lowLatency ? '退出低延迟' : '低延迟模式'}
          </button>
        </div>
      </header>

      <LiveScreen state={state} />

      <section class="grid" style="margin-top:18px">
        <article class="panel">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <h2>发言队列</h2>
            <span class="pill">{roomQueue().length} 条 · {activeRoom().simultaneousChannels} 个同传频道</span>
          </div>
          {roomQueue().map((speech, index) => (
            <div class={`queue-row ${speech.status === 'speaking' ? 'active' : ''}`} key={speech.id}>
              <strong>#{index + 1}</strong>
              <div>
                <b>{speech.speaker}</b>
                <div style="color:#638087;font-size:13px">
                  {speech.delegation} · {speech.language}
                  {speech.relayLanguage ? ` → ${speech.relayLanguage} → 目标语种` : '（直接翻译）'} · {speech.topic}
                </div>
              </div>
              <span class="pill">{speech.status}</span>
              <div style="display:flex;gap:6px">
                {speech.status === 'queued' && (
                  <button onClick$={() => advanceSpeech$(speech.id, 'speaking')}>开始</button>
                )}
                {speech.status === 'speaking' && (
                  <>
                    <button onClick$={() => advanceSpeech$(speech.id, 'done')}>结束</button>
                    <button
                      class="secondary"
                      onClick$={() => (speech.remainingSeconds = Math.max(0, speech.remainingSeconds - 60))}
                    >
                      减1分钟
                    </button>
                  </>
                )}
                {speech.status === 'queued' && (
                  <button class="danger" onClick$={() => advanceSpeech$(speech.id, 'skipped')}>跳过</button>
                )}
              </div>
            </div>
          ))}
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:18px">
            <QueueFormEl onSubmit$={addSpeech$}>
              <QueueField name="speaker">
                {(field, props) => (
                  <input
                    {...props}
                    value={field.value}
                    onInput$={(event) => (field.value = (event.target as HTMLInputElement).value)}
                    placeholder="发言人"
                  />
                )}
              </QueueField>
              <QueueField name="delegation">
                {(field, props) => (
                  <input
                    {...props}
                    value={field.value}
                    onInput$={(event) => (field.value = (event.target as HTMLInputElement).value)}
                    placeholder="代表团"
                  />
                )}
              </QueueField>
              <QueueField name="language">
                {(field, props) => (
                  <input
                    {...props}
                    value={field.value}
                    onInput$={(event) => (field.value = (event.target as HTMLInputElement).value)}
                    placeholder="源语言"
                  />
                )}
              </QueueField>
              <QueueField name="relayLanguage">
                {(field, props) => (
                  <input
                    {...props}
                    value={field.value}
                    onInput$={(event) => (field.value = (event.target as HTMLInputElement).value)}
                    placeholder="中间语言（小语种必填，如英语）"
                  />
                )}
              </QueueField>
              <QueueField name="topic">
                {(field, props) => (
                  <input
                    {...props}
                    value={field.value}
                    onInput$={(event) => (field.value = (event.target as HTMLInputElement).value)}
                    placeholder="议题"
                  />
                )}
              </QueueField>
              <QueueField name="plannedSeconds" type="number">
                {(field, props) => (
                  <input
                    {...props}
                    type="number"
                    value={field.value}
                    onInput$={(event) => (field.value = Number((event.target as HTMLInputElement).value))}
                    placeholder="计划秒数"
                  />
                )}
              </QueueField>
              <button type="submit">加入队列</button>
            </QueueFormEl>
          </div>
        </article>

        <aside class="panel">
          <h2>频道与译员</h2>
          {roomChannels().map((channel) => (
            <div style="padding:12px 0;border-bottom:1px solid #e6efee" key={channel.id}>
              <div style="display:flex;justify-content:space-between">
                <b>
                  {channel.language} · {channel.interpreter}
                  <span class={`pill role-${channel.role}`} style="margin-left:6px">
                    {channel.role === 'relay' ? '接力' : channel.role === 'target' ? '目标' : '直接'}
                  </span>
                </b>
                <span class="pill">{channel.status}</span>
              </div>
              <div class="decorative" style="margin:8px 0">
                <Progress.Root value={channel.health} max={100} />
              </div>
              <div style="display:flex;gap:8px;flex-wrap:wrap">
                <button class="secondary" onClick$={() => handoff$(channel.id)}>开始交接</button>
                {channel.status === 'handoff' && (
                  <button onClick$={() => completeHandoff$(channel, `替补译员-${channel.language}`)}>
                    完成交接
                  </button>
                )}
                <button
                  class={channel.status === 'offline' ? '' : 'danger'}
                  onClick$={() => toggleOffline$(channel)}
                >
                  {channel.status === 'offline' ? '恢复上线' : '模拟掉线'}
                </button>
              </div>
            </div>
          ))}

          <h3 style="margin-top:18px">实时字幕存档</h3>
          {state.captions.filter((caption) => caption.roomId === state.activeRoomId).length === 0 && (
            <p style="color:#638087">暂无字幕。</p>
          )}
          {state.captions
            .filter((caption) => caption.roomId === state.activeRoomId)
            .map((caption) => (
              <div
                style="margin-top:10px;padding:10px;background:#f1f8f7;border-radius:10px"
                key={caption.id}
              >
                <b>
                  {caption.language} · {caption.interpreter} · v{caption.revision}
                </b>
                <p>{caption.text}</p>
              </div>
            ))}
        </aside>
      </section>

      <section class="grid" style="margin-top:18px">
        <RelayConsole state={state} />
        <article class="panel">
          <h2>术语库</h2>
          {state.terms.map((term) => (
            <div class="queue-row" key={term.id}>
              <span />
              <div>
                <b>{term.phrase}</b>
                <div>{term.translation} · {term.language}</div>
              </div>
              <span class="pill">{term.approved ? '已批准' : '待审'}</span>
              <button disabled={term.approved} onClick$={() => approveTerm$(term.id)}>批准</button>
            </div>
          ))}
        </article>
      </section>

      <section class="panel" style="margin-top:18px">
        <h2>操作与交接时间线</h2>
        {state.audits
          .filter((audit) => audit.roomId === state.activeRoomId)
          .slice(0, 12)
          .map((audit) => (
            <div style="padding:10px 0;border-bottom:1px solid #e6efee" key={audit.id}>
              <small>{new Date(audit.at).toLocaleTimeString()}</small>
              <div>{audit.message}</div>
            </div>
          ))}
      </section>
    </main>
  );
});

export const head: DocumentHead = {
  title: '国际会议同声传译控制台',
  meta: [{ name: 'description', content: '接力链同传：源语言→中间语言→目标语言，中间段确认后下游才出字幕，发言切换立即失效，接力失败从断点恢复' }]
};
