import { supabase } from './cloud';

/**
 * Web Push for the hosted PWA (iPhone-first). The public VAPID key ships here (public by
 * design); the private half lives ONLY in the 'push' edge function's secrets. iOS only
 * delivers Web Push to apps ADDED TO THE HOME SCREEN, so support() distinguishes
 * "works here" from "install first".
 */

export const VAPID_PUBLIC = 'BNVcV_2ao3AUbu3HqHCWnGuCl0Lyl_Z12IIKsSIO_lj34I4vlFdifn2t4Wc17zAObRWziSkAOnLtHh_Hq-c8L_E';

const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

export function pushSupport(): 'ok' | 'needs-install' | 'unsupported' {
  if (window.exponential) return 'unsupported'; // desktop app has native notifications
  if ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window) return 'ok';
  if (isIOS() && !standalone()) return 'needs-install'; // Safari tab: install to Home Screen first
  return 'unsupported';
}

export async function pushEnabled(): Promise<boolean> {
  if (pushSupport() !== 'ok' || Notification.permission !== 'granted') return false;
  const reg = await navigator.serviceWorker.getRegistration();
  return !!(await reg?.pushManager.getSubscription());
}

function b64ToBytes(b64: string): Uint8Array {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Ask permission, subscribe, and save the subscription for the push edge function. */
export async function enablePush(): Promise<'on' | 'denied' | 'failed'> {
  try {
    if ((await Notification.requestPermission()) !== 'granted') return 'denied';
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(VAPID_PUBLIC).buffer as ArrayBuffer });
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) return 'failed';
    const j = sub.toJSON();
    const { error } = await supabase.from('push_subscriptions').upsert({
      endpoint: sub.endpoint, user_id: u.user.id, p256dh: j.keys?.p256dh ?? '', auth: j.keys?.auth ?? '', ua: navigator.userAgent.slice(0, 120),
    }, { onConflict: 'endpoint' });
    if (error) throw error;
    return 'on';
  } catch (e) {
    console.warn('[push] enable failed', e);
    return 'failed';
  }
}
