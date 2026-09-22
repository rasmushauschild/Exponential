import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Person } from './types';
import { shortName } from './types';
import { Avatar } from './WeekPlan';
import { decorate } from './richtext';
import {
  attachmentUrl, createChannel, deleteChannel, deleteMessage, dmName, dmOther, editMessage,
  fetchMessages, isDm, markRead, onChatEvent, openDm, sendMessage, setChannelMembers,
  toggleReaction, updateChannel, uploadChatFile, type Attachment, type Channel, type ChatMessage,
} from './chat';

const EMOJI = ['👍', '❤️', '😂', '🎉', '🙌', '🔥', '👀', '✅', '💯', '😅', '😍', '🤔', '😢', '😮', '🙏', '👏', '🚀', '⭐', '☕', '🍿', '💪', '🫡', '🤝', '🥳', '😴', '🤯', '🧠', '⚡', '🌱', '🍾', '🎯', '🛠️'];

interface Props {
  teamId: string;
  me: string;
  people: Person[];
  canModerate: boolean;
  cloud: boolean;
  channels: Channel[];
  activeId: string | null;
  onActive: (id: string | null) => void;
  onRefreshChannels: () => void;
  full: boolean; // fullscreen side panel: room for the channel rail; compact shows a dropdown
  onError: (msg: string) => void;
}

const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dayKey = (iso: string) => iso.slice(0, 10);
const fmtDay = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const yest = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
};
const fmtSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function ChatPage(p: Props) {
  const { teamId, me, people, cloud, channels, activeId, onActive, full } = p;
  const active = channels.find((c) => c.id === activeId) ?? null;
  const [msgs, setMsgs] = useState<ChatMessage[]>([]);
  const [olderDone, setOlderDone] = useState(false);
  const cache = useRef(new Map<string, ChatMessage[]>());
  const listRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [newChannel, setNewChannel] = useState(false);
  // compact panel: a conversations screen first, then the thread with a back row
  const [listMode, setListMode] = useState(true);

  // Load (or restore) the open channel's messages; mark it read.
  useEffect(() => {
    if (!active) return;
    let gone = false;
    const cached = cache.current.get(active.id);
    if (cached) setMsgs(cached);
    setOlderDone(false);
    fetchMessages(teamId, active.id, cloud).then((m) => {
      if (gone) return;
      cache.current.set(active.id, m);
      setMsgs(m);
      setOlderDone(m.length < 60);
      markRead(teamId, active.id, me, cloud).then(p.onRefreshChannels);
    }).catch((e) => p.onError(String((e as Error).message ?? e)));
    stickBottom.current = true;
    return () => { gone = true; };
  }, [active?.id, teamId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live events: append to the open channel (and keep the cache fresh for the rest).
  useEffect(() => onChatEvent((e) => {
    if (e.teamId !== teamId) return;
    if (e.type === 'message') {
      const cur = cache.current.get(e.message.channelId);
      if (cur && !cur.some((m) => m.id === e.message.id)) cache.current.set(e.message.channelId, [...cur, e.message]);
      if (e.message.channelId === activeId) {
        setMsgs((ms) => (ms.some((m) => m.id === e.message.id) ? ms : [...ms, e.message]));
        if (document.hasFocus()) markRead(teamId, e.message.channelId, me, cloud).then(p.onRefreshChannels);
      }
    }
    if (e.type === 'message-changed') {
      const patch = (ms: ChatMessage[]) => (e.message.at === '' || e.message.deletedAt
        ? ms.filter((m) => m.id !== e.message.id)
        : ms.map((m) => (m.id === e.message.id ? { ...e.message } : m)));
      const cur = cache.current.get(e.message.channelId);
      if (cur) cache.current.set(e.message.channelId, patch(cur));
      if (e.message.channelId === activeId) setMsgs(patch);
    }
  }), [teamId, activeId, cloud, me]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stickBottom.current) el.scrollTop = el.scrollHeight;
  }, [msgs, activeId]);

  const onScroll = () => {
    const el = listRef.current!;
    stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const loadOlder = async () => {
    if (!active || !msgs.length) return;
    const el = listRef.current!;
    const keep = el.scrollHeight - el.scrollTop;
    const older = await fetchMessages(teamId, active.id, cloud, msgs[0].at);
    if (older.length < 60) setOlderDone(true);
    const merged = [...older, ...msgs.filter((m) => !older.some((o) => o.id === m.id))];
    cache.current.set(active.id, merged);
    stickBottom.current = false;
    setMsgs(merged);
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight - keep; });
  };

  const person = (id?: string) => people.find((x) => x.id === id);

  // group consecutive messages from one author within 5 minutes
  const grouped: { msg: ChatMessage; head: boolean; day?: string }[] = msgs.map((m, i) => {
    const prev = msgs[i - 1];
    const day = !prev || dayKey(prev.at) !== dayKey(m.at) ? fmtDay(m.at) : undefined;
    const head = !!day || !prev || prev.author !== m.author || +new Date(m.at) - +new Date(prev.at) > 5 * 60_000;
    return { msg: m, head, day };
  });

  const regular = channels.filter((c) => !isDm(c));
  const dms = channels.filter(isDm);
  const teammates = people.filter((x) => !x.id.startsWith('pending:'));

  const openDmWith = async (personId: string) => {
    const ch = dms.find((d) => d.name === dmName(me, personId));
    if (ch) { onActive(ch.id); return; }
    try { const id = await openDm(teamId, me, personId, cloud); p.onRefreshChannels(); onActive(id); }
    catch (e) { p.onError(String((e as Error).message ?? e)); }
  };

  return (
    <div className={`chat${full ? ' full' : ''}`}>
      {full && (
      <aside className="chat-rail">
        <div className="side-title">Chat</div>
        <div className="chat-rail-head">
          <span className="chat-rail-title">Channels</span>
          <span className="panel-spacer" />
          <button className="icon-btn small" title="New channel" onClick={() => setNewChannel(true)}>+</button>
        </div>
        {regular.map((c) => (
          <button key={c.id} className={`chat-ch${c.id === activeId ? ' active' : ''}${c.unread ? ' unread' : ''}`} onClick={() => onActive(c.id)}>
            <span className="chat-hash">{c.private ? <LockGlyph /> : '#'}</span>
            <span className="chat-ch-name">{c.name}</span>
            {c.unread > 0 && <span className="badge">{c.unread}</span>}
          </button>
        ))}
        {newChannel && (
          <NewChannelForm people={people} me={me} onClose={() => setNewChannel(false)}
            onCreate={async (name, priv, members) => {
              try { await createChannel(teamId, me, name, priv, members, cloud); setNewChannel(false); p.onRefreshChannels(); }
              catch (e) { p.onError(String((e as Error).message ?? e)); }
            }} />
        )}
        <div className="chat-rail-head dm">
          <span className="chat-rail-title">Direct messages</span>
        </div>
        {teammates.map((x) => {
          const ch = dms.find((d) => d.name === dmName(me, x.id));
          return (
            <button key={x.id} className={`chat-ch${ch && ch.id === activeId ? ' active' : ''}${ch?.unread ? ' unread' : ''}`}
              onClick={() => openDmWith(x.id)}>
              <Avatar person={x} size={18} />
              <span className="chat-ch-name">{shortName(x.name)}{x.id === me ? ' (you)' : ''}</span>
              {ch && ch.unread > 0 && <span className="badge">{ch.unread}</span>}
            </button>
          );
        })}
      </aside>
      )}

      {!full && (listMode || !active) ? (
        <div className="chat-main chat-list-view">
          <div className="side-title">Chat</div>
          <div className="chat-convos">
            <div className="chat-rail-head">
              <span className="chat-rail-title">Channels</span>
              <span className="panel-spacer" />
              <button className="icon-btn small" title="New channel" onClick={() => setNewChannel(true)}>+</button>
            </div>
            {regular.map((ch) => (
              <button key={ch.id} className={`chat-ch${ch.unread ? ' unread' : ''}`} onClick={() => { onActive(ch.id); setListMode(false); }}>
                <span className="chat-hash">{ch.private ? <LockGlyph /> : '#'}</span>
                <span className="chat-ch-name">{ch.name}</span>
                {ch.unread > 0 && <span className="badge">{ch.unread}</span>}
              </button>
            ))}
            {newChannel && (
              <NewChannelForm people={people} me={me} onClose={() => setNewChannel(false)}
                onCreate={async (name, priv, members) => {
                  try { await createChannel(teamId, me, name, priv, members, cloud); setNewChannel(false); p.onRefreshChannels(); }
                  catch (e) { p.onError(String((e as Error).message ?? e)); }
                }} />
            )}
            <div className="chat-rail-head dm">
              <span className="chat-rail-title">Direct messages</span>
            </div>
            {teammates.map((x) => {
              const ch = dms.find((d) => d.name === dmName(me, x.id));
              return (
                <button key={x.id} className={`chat-ch${ch?.unread ? ' unread' : ''}`}
                  onClick={async () => { await openDmWith(x.id); setListMode(false); }}>
                  <Avatar person={x} size={20} />
                  <span className="chat-ch-name">{shortName(x.name)}{x.id === me ? ' (you)' : ''}</span>
                  {ch && ch.unread > 0 && <span className="badge">{ch.unread}</span>}
                </button>
              );
            })}
          </div>
        </div>
      ) : active ? (
        <div className="chat-main">
          {!full && (
            <div className="chat-thread-head">
              <button className="meet-back chat-back" onClick={() => setListMode(true)}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
                Chat
              </button>
              <span className="chat-thread-name">
                {isDm(active)
                  ? (() => { const other = people.find((x) => x.id === dmOther(active, me)); return <>{other && <Avatar person={other} size={22} />}{other ? shortName(other.name) : 'Direct message'}{dmOther(active, me) === me ? ' (you)' : ''}</>; })()
                  : <><span className="chat-hash-big">{active.private ? <LockGlyph /> : '#'}</span>{active.name}</>}
              </span>
            </div>
          )}
          {full && (isDm(active) ? (
            <div className="panel-head chat-head">
              {(() => { const other = people.find((x) => x.id === dmOther(active, me)); return other ? <><Avatar person={other} size={30} /><span className="panel-title">{shortName(other.name)}{other.id === me ? ' (you)' : ''}</span></> : <span className="panel-title">Direct message</span>; })()}
            </div>
          ) : (
          <ChannelHead key={`head-${active.id}`} channel={active} me={me} people={people} canModerate={p.canModerate} /* key must differ from the sibling Composer's — same-key siblings made React orphan the old head in the DOM */
            onRename={(name) => updateChannel(teamId, active.id, { name }, cloud).catch((e) => p.onError(String(e.message ?? e)))}
            onTopic={(topic) => updateChannel(teamId, active.id, { topic }, cloud).catch((e) => p.onError(String(e.message ?? e)))}
            onMembers={(m) => setChannelMembers(teamId, active.id, m, cloud).then(p.onRefreshChannels).catch((e) => p.onError(String(e.message ?? e)))}
            onDelete={() => deleteChannel(teamId, active.id, cloud).then(() => { onActive(channels.find((c) => c.id !== active.id)?.id ?? null); p.onRefreshChannels(); }).catch((e) => p.onError(String(e.message ?? e)))}
          />
          ))}
          <div className="chat-list" ref={listRef} onScroll={onScroll}>
            {!olderDone && msgs.length >= 60 && <button className="pill chat-older" onClick={loadOlder}>Load earlier messages</button>}
            {grouped.map(({ msg, head, day }) => (
              <div key={msg.id}>
                {day && <div className="chat-day"><span>{day}</span></div>}
                <MessageRow msg={msg} head={head} author={person(msg.author)} mine={msg.author === me} me={me} people={people} canModerate={p.canModerate} cloud={cloud}
                  onEdit={(body) => editMessage(teamId, msg, body, cloud).catch((e) => p.onError(String(e.message ?? e)))}
                  onDelete={() => deleteMessage(teamId, msg, cloud).catch((e) => p.onError(String(e.message ?? e)))}
                  onReact={(emoji) => toggleReaction(teamId, msg, emoji, me, cloud).catch((e) => p.onError(String(e.message ?? e)))}
                  onImage={setLightbox} />
              </div>
            ))}
            {msgs.length === 0 && <div className="chat-empty">No messages yet — say hi 👋</div>}
          </div>
          <Composer key={`comp-${active.id}`} channel={active} teamId={teamId} cloud={cloud} onError={p.onError}
            label={isDm(active) ? `Message ${shortName(people.find((x) => x.id === dmOther(active, me))?.name ?? '')}` : `Message #${active.name}`}
            onSend={async (body, atts) => {
              const m = await sendMessage(teamId, active.id, me, body, atts, cloud);
              if (cloud) { // realtime echoes it back, but append now so sending feels instant
                cache.current.set(active.id, [...(cache.current.get(active.id) ?? []), m]);
                setMsgs((ms) => (ms.some((x) => x.id === m.id) ? ms : [...ms, m]));
              }
              stickBottom.current = true;
            }} />
        </div>
      ) : (
        <div className="chat-main"><div className="chat-empty">Pick a channel</div></div>
      )}

      {lightbox && createPortal(
        <div className="lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="" />
        </div>, document.body)}
    </div>
  );
}

function LockGlyph() {
  return <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6"><rect x="4" y="10" width="16" height="11" rx="2.5" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>;
}

function NewChannelForm({ people, me, onCreate, onClose }: { people: Person[]; me: string; onCreate: (name: string, priv: boolean, members: string[]) => void; onClose: () => void }) {
  const [name, setName] = useState('');
  const [priv, setPriv] = useState(false);
  const [members, setMembers] = useState<Set<string>>(new Set());
  return (
    <div className="chat-new">
      <input autoFocus placeholder="channel-name" value={name}
        onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, '-').replace(/^dm:+/, ''))}
        onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) onCreate(name.trim(), priv, [...members]); if (e.key === 'Escape') onClose(); }} />
      <label className="chat-priv"><input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} /> Private</label>
      {priv && (
        <div className="chat-member-pick">
          {people.filter((x) => x.id !== me).map((x) => (
            <button key={x.id} className={`pill${members.has(x.id) ? ' toggle active' : ''}`}
              onClick={() => setMembers((s) => { const n = new Set(s); if (n.has(x.id)) n.delete(x.id); else n.add(x.id); return n; })}>
              {shortName(x.name)}
            </button>
          ))}
        </div>
      )}
      <div className="chat-new-foot">
        <button className="pill" onClick={onClose}>Cancel</button>
        <button className="pill toggle active" disabled={!name.trim()} onClick={() => name.trim() && onCreate(name.trim(), priv, [...members])}>Create</button>
      </div>
    </div>
  );
}

function ChannelHead({ channel, me, people, canModerate, onRename, onTopic, onMembers, onDelete }: {
  channel: Channel; me: string; people: Person[]; canModerate: boolean;
  onRename: (v: string) => void; onTopic: (v: string) => void; onMembers: (m: string[]) => void; onDelete: () => void;
}) {
  const canManage = canModerate || channel.createdBy === me || !channel.createdBy;
  const [editTopic, setEditTopic] = useState(false);
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest('.chat-menu')) setMenu(null); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menu]);
  return (
    <div className="panel-head chat-head">
      {renaming ? (
        <input className="chat-rename" autoFocus defaultValue={channel.name}
          onBlur={(e) => { const v = e.target.value.trim().toLowerCase().replace(/\s+/g, '-'); if (v && v !== channel.name) onRename(v); setRenaming(false); }}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(false); }} />
      ) : (
        <span className="panel-title"><span className="chat-hash-big">{channel.private ? <LockGlyph /> : '#'}</span>{channel.name}</span>
      )}
      {editTopic ? (
        <input className="chat-topic-input" autoFocus defaultValue={channel.topic ?? ''} placeholder="Add a topic"
          onBlur={(e) => { onTopic(e.target.value.trim()); setEditTopic(false); }}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditTopic(false); }} />
      ) : (
        <button className="chat-topic" onClick={() => canManage && setEditTopic(true)}>{channel.topic || (canManage ? 'Add a topic' : '')}</button>
      )}
      <span className="panel-spacer" />
      {channel.private && (
        <span className="chat-members" title="Members">
          {(channel.members ?? []).map((id) => people.find((x) => x.id === id)).filter(Boolean).slice(0, 6).map((x) => <Avatar key={x!.id} person={x!} size={20} />)}
        </span>
      )}
      {(canManage || channel.private) && (
        <button className="icon-btn" title="Channel options" onClick={(e) => setMenu((e.currentTarget as HTMLElement).getBoundingClientRect())}>⋯</button>
      )}
      {menu && createPortal(
        <div className="status-menu chat-menu" style={{ position: 'fixed', top: menu.bottom + 6, right: window.innerWidth - menu.right }}>
          {canManage && <button onClick={() => { setRenaming(true); setMenu(null); }}>Rename</button>}
          {channel.private && canManage && <button onClick={() => { setMembersOpen(true); setMenu(null); }}>Members…</button>}
          {canManage && channel.name !== 'general' && <button className="danger" onClick={() => { if (confirm(`Delete #${channel.name}? Its messages are removed for everyone.`)) onDelete(); setMenu(null); }}>Delete channel</button>}
        </div>, document.body)}
      {membersOpen && (
        <MembersSheet channel={channel} me={me} people={people} onClose={() => setMembersOpen(false)} onSave={(m) => { onMembers(m); setMembersOpen(false); }} />
      )}
    </div>
  );
}

function MembersSheet({ channel, me, people, onClose, onSave }: { channel: Channel; me: string; people: Person[]; onClose: () => void; onSave: (m: string[]) => void }) {
  const [sel, setSel] = useState<Set<string>>(new Set(channel.members ?? [me]));
  return createPortal(
    <div className="sheet-veil" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet chat-members-sheet">
        <div className="sheet-title">Members of #{channel.name}</div>
        <div className="chat-member-pick">
          {people.map((x) => (
            <button key={x.id} className={`pill${sel.has(x.id) ? ' toggle active' : ''}`} disabled={x.id === me}
              onClick={() => setSel((s) => { const n = new Set(s); if (n.has(x.id)) n.delete(x.id); else n.add(x.id); return n; })}>
              {shortName(x.name)}
            </button>
          ))}
        </div>
        <div className="chat-new-foot">
          <button className="pill" onClick={onClose}>Cancel</button>
          <button className="pill toggle active" onClick={() => onSave([...sel])}>Save</button>
        </div>
      </div>
    </div>, document.body);
}

function MessageRow({ msg, head, author, mine, me, people, canModerate, cloud, onEdit, onDelete, onReact, onImage }: {
  msg: ChatMessage; head: boolean; author?: Person; mine: boolean; me: string; people: Person[]; canModerate: boolean; cloud: boolean;
  onEdit: (body: string) => void; onDelete: () => void; onReact: (emoji: string) => void; onImage: (url: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [pick, setPick] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (!pick) return;
    const close = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest('.chat-emoji-pop')) setPick(null); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [pick]);
  return (
    <div className={`chat-msg${head ? ' head' : ''}`}>
      <span className="chat-gutter">
        {head ? (author ? <Avatar person={author} size={30} /> : <span className="chat-ghost-avatar" />) : <span className="chat-hover-time">{fmtTime(msg.at)}</span>}
      </span>
      <div className="chat-bubble">
        {head && (
          <div className="chat-meta">
            <span className="chat-author">{author ? shortName(author.name) : 'Someone'}</span>
            <span className="chat-time">{fmtTime(msg.at)}</span>
            {msg.editedAt && <span className="chat-time">(edited)</span>}
          </div>
        )}
        {editing ? (
          <textarea className="chat-edit" autoFocus defaultValue={msg.body} rows={2}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const v = (e.target as HTMLTextAreaElement).value.trim(); if (v && v !== msg.body) onEdit(v); setEditing(false); }
              if (e.key === 'Escape') setEditing(false);
            }}
            onBlur={() => setEditing(false)} />
        ) : (
          msg.body && <div className="chat-body">{renderChat(msg.body)}{msg.editedAt && !head ? <span className="chat-time"> (edited)</span> : null}</div>
        )}
        {msg.attachments?.map((a, i) => <AttachmentView key={i} att={a} cloud={cloud} onImage={onImage} />)}
        {msg.reactions && Object.keys(msg.reactions).length > 0 && (
          <div className="chat-reacts">
            {Object.entries(msg.reactions).map(([emo, users]) => (
              <button key={emo} className={users.includes(me) ? 'on' : ''} onClick={() => onReact(emo)}
                title={users.map((u) => shortName(people.find((x) => x.id === u)?.name ?? 'Someone')).join(', ')}>
                {emo} <span>{users.length}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {!editing && (
        <span className="chat-actions">
          <button title="React" onClick={(e) => setPick((e.currentTarget as HTMLElement).getBoundingClientRect())}><SmileGlyph /></button>
          {mine && <button title="Edit" onClick={() => setEditing(true)}><PencilGlyph /></button>}
          {(mine || canModerate) && <button title="Delete" onClick={onDelete}><CrossGlyph /></button>}
        </span>
      )}
      {pick && createPortal(
        <div className="status-menu chat-emoji-pop" style={{ position: 'fixed', top: Math.min(pick.bottom + 6, window.innerHeight - 180), right: Math.max(12, window.innerWidth - pick.right - 60) }}>
          {EMOJI.map((emo) => <button key={emo} onClick={() => { onReact(emo); setPick(null); }}>{emo}</button>)}
        </div>, document.body)}
    </div>
  );
}

function SmileGlyph() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M8.5 14a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01" /></svg>;
}

/** Like renderInlineMd, but URLs become real links (opened externally by Electron). */
function renderChat(text: string) {
  const parts = decorate(text);
  if (!parts) return text;
  return parts.map((p, k) => {
    if (typeof p === 'string') return p;
    if ('url' in p) return <a key={k} className="md-linkish" href={p.url.startsWith('http') ? p.url : `https://${p.url}`} target="_blank" rel="noreferrer">{p.label}</a>;
    if (p.style === 'b') return <b key={k}>{p.text}</b>;
    if (p.style === 'i') return <i key={k}>{p.text}</i>;
    if (p.style === 's') return <s key={k}>{p.text}</s>;
    return <b key={k}><i>{p.text}</i></b>;
  });
}

function AttachmentView({ att, cloud, onImage }: { att: Attachment; cloud: boolean; onImage: (url: string) => void }) {
  const [url, setUrl] = useState<string | null>(att.path.startsWith('data:') ? att.path : null);
  const isImage = att.type.startsWith('image/');
  useEffect(() => {
    let gone = false;
    if (!url) attachmentUrl(att, cloud).then((u) => { if (!gone) setUrl(u); }).catch(() => {});
    return () => { gone = true; };
  }, [att.path]); // eslint-disable-line react-hooks/exhaustive-deps
  if (isImage) {
    return url
      ? <img className="chat-img" src={url} style={att.w && att.h ? { aspectRatio: `${att.w} / ${att.h}` } : undefined} onClick={() => onImage(url)} alt={att.name} />
      : <div className="chat-img chat-img-loading" style={att.w && att.h ? { aspectRatio: `${att.w} / ${att.h}` } : undefined} />;
  }
  return (
    <a className="chat-file" href={url ?? undefined} download={att.name} target="_blank" rel="noreferrer">
      <FileGlyph />
      <span className="chat-file-name">{att.name}</span>
      <span className="chat-file-size">{fmtSize(att.size)}</span>
    </a>
  );
}

function Composer({ channel, label, teamId, cloud, onSend, onError }: {
  channel: Channel; label: string; teamId: string; cloud: boolean;
  onSend: (body: string, atts: Attachment[] | undefined) => Promise<void>; onError: (m: string) => void;
}) {
  const [text, setText] = useState('');
  const [atts, setAtts] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [drag, setDrag] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const sending = useRef(false);

  const grow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(180, ta.scrollHeight)}px`;
  };

  const addFiles = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      setUploading((n) => n + 1);
      try {
        const att = await uploadChatFile(teamId, f, cloud);
        setAtts((a) => [...a, att]);
      } catch (e) { onError(String((e as Error).message ?? e)); }
      setUploading((n) => n - 1);
    }
    taRef.current?.focus();
  };

  const send = async () => {
    const body = text.trim();
    if ((!body && !atts.length) || sending.current || uploading) return;
    sending.current = true;
    try {
      await onSend(body, atts.length ? atts : undefined);
      setText(''); setAtts([]);
      requestAnimationFrame(grow);
    } catch (e) { onError(String((e as Error).message ?? e)); }
    sending.current = false;
    taRef.current?.focus();
  };

  return (
    <div className={`chat-compose${drag ? ' dragging' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); }}>
      {(atts.length > 0 || uploading > 0) && (
        <div className="chat-att-row">
          {atts.map((a, i) => (
            <span key={i} className="chat-att-chip" title={a.name}>
              {a.type.startsWith('image/') ? <ThumbChip att={a} cloud={cloud} /> : <FileGlyph />}
              <span className="chat-att-name">{a.name}</span>
              <button onClick={() => setAtts((x) => x.filter((_, j) => j !== i))}>×</button>
            </span>
          ))}
          {uploading > 0 && <span className="chat-att-chip loading">Uploading…</span>}
        </div>
      )}
      <div className="chat-compose-row">
        <button className="icon-btn" title="Attach a file" onClick={() => fileRef.current?.click()}><ClipGlyph /></button>
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => { if (e.target.files?.length) addFiles(e.target.files); e.target.value = ''; }} />
        <textarea
          ref={taRef}
          rows={1}
          placeholder={label}
          value={text}
          onChange={(e) => { setText(e.target.value); grow(); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          onPaste={(e) => {
            const imgs = Array.from(e.clipboardData.items).filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean) as File[];
            if (imgs.length) { e.preventDefault(); addFiles(imgs); }
          }}
        />
        <button className="pill toggle active chat-send" disabled={(!text.trim() && !atts.length) || uploading > 0} onClick={send}>Send</button>
      </div>
    </div>
  );
}

function ThumbChip({ att, cloud }: { att: Attachment; cloud: boolean }) {
  const [url, setUrl] = useState<string | null>(att.path.startsWith('data:') ? att.path : null);
  useEffect(() => { let gone = false; if (!url) attachmentUrl(att, cloud).then((u) => !gone && setUrl(u)).catch(() => {}); return () => { gone = true; }; }, [att.path]); // eslint-disable-line react-hooks/exhaustive-deps
  return url ? <img src={url} alt="" /> : <FileGlyph />;
}

function PencilGlyph() { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></svg>; }
function CrossGlyph() { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M18 6 6 18M6 6l12 12" /></svg>; }
function ClipGlyph() { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>; }
function FileGlyph() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /></svg>; }
