import {Linking} from 'react-native';
import {createNavigationContainerRef} from '@react-navigation/native';
import type {RootStackParamList} from '@/App';

/**
 * The navigator, reachable from outside the tree.
 *
 * A toast is mounted ABOVE the NavigationContainer, not inside it — it has to outlive the screen
 * that raised it — so `useNavigation` is not available to the one link that matters most, the
 * explorer link on a confirmed transaction. A ref is how react-navigation answers that, and it
 * also lets {openLink} be a plain function rather than a hook, which is what makes it usable from
 * a row's onPress without threading navigation through every component in between.
 */
export const navigationRef = createNavigationContainerRef<RootStackParamList>();

/**
 * Open a web page inside the app.
 *
 * Every external link in the app goes through here. Handing a URL to `Linking.openURL` leaves
 * for Safari, and the user comes back — if they come back — to a cold app and a lost place in
 * whatever they were doing; the common case is glancing at a transaction on Etherscan, which is
 * five seconds of reading that should not cost the screen behind it.
 *
 * Falls back to Safari when the navigator is not mounted yet (a link tapped on the lock screen,
 * or before the container has attached) and for anything that is not a web page — a `mailto:` or
 * a wallet deep link has no business in a WebView and iOS will route it properly.
 */
export function openLink(url: string, title?: string): void {
  const web = /^https?:\/\//i.test(url);
  if (web && navigationRef.isReady()) {
    navigationRef.navigate('Browser', {url, title});
    return;
  }
  void Linking.openURL(url).catch(() => {});
}
