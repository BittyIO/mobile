import {useEffect} from 'react';
import {Alert, Linking} from 'react-native';
import {API_BASE, apiFetch} from '@/core/chain';
import {getPref, setPref} from '@/core/prefs';
import {APP_VERSION} from '@/core/app-version';

/**
 * Is there a newer build than this one, and where is it.
 *
 * Asked of our own server (GET /api/app/version) rather than Apple's lookup directly: the app is on
 * TestFlight, which the lookup does not know, and the server answers for both — its own figures now,
 * the App Store's once the app is listed there. `minimum` is the floor below which the prompt has no
 * "Later".
 */
export type UpdateInfo = {latest: string; minimum: string; url: string};

const CURRENT = APP_VERSION.replace(/^v/, '');

/** -1, 0 or 1, comparing dotted numbers part by part ("0.0.10" is after "0.0.9"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** The server's answer, or null when it could not be asked. */
export async function fetchUpdateInfo(): Promise<UpdateInfo | null> {
  try {
    const res = await apiFetch(`${API_BASE}/api/app/version`);
    if (!res.ok) return null;
    const j = (await res.json()) as Partial<UpdateInfo>;
    return j.latest && j.url ? {latest: j.latest, minimum: j.minimum ?? '0', url: j.url} : null;
  } catch {
    return null;
  }
}

export const isNewer = (info: UpdateInfo) => compareVersions(info.latest, CURRENT) > 0;
export const isRequired = (info: UpdateInfo) => compareVersions(CURRENT, info.minimum) < 0;

type T = (key: string, params?: Record<string, string | number>) => string;

/** The prompt itself: what is out, and a button to it. No "Later" below the minimum. */
export function promptUpdate(info: UpdateInfo, t: T, onLater?: () => void) {
  const required = isRequired(info);
  const open = () => void Linking.openURL(info.url).catch(() => {});
  Alert.alert(
    t('mobile.settings.update_title'),
    t(required ? 'mobile.settings.update_required_body' : 'mobile.settings.update_body', {version: `v${info.latest}`}),
    required
      ? [{text: t('mobile.settings.update_now'), onPress: open}]
      : [
          {text: t('mobile.settings.update_later'), style: 'cancel', onPress: onLater},
          {text: t('mobile.settings.update_now'), onPress: open},
        ],
    {cancelable: !required},
  );
}

/** The version the user said "Later" to, so the launch check does not ask about it again. */
const SKIPPED = 'update.skipped';

/**
 * Once per launch: when a newer build is out, say so. A version the user put off is not raised
 * again at launch — the App version row in Settings still finds it — unless it is now required.
 */
export function useLaunchUpdateCheck(t: T) {
  useEffect(() => {
    let live = true;
    fetchUpdateInfo().then((info) => {
      if (!live || !info || !isNewer(info)) return;
      if (!isRequired(info) && getPref(SKIPPED) === info.latest) return;
      promptUpdate(info, t, () => setPref(SKIPPED, info.latest));
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
