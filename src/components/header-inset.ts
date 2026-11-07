import {useHeaderHeight} from '@react-navigation/elements';
import {Platform} from 'react-native';

/**
 * How far a page must push its content down to clear the navigation header.
 *
 * iOS: the header is translucent and the page draws beneath it (see HEADER_TRANSPARENT in App.tsx),
 * so pages pad/inset by the header height. Android: the header is opaque and already takes its own
 * space, so the inset is 0 — padding by the header height there leaves a header-sized gap.
 */
export function useTransparentHeaderInset(): number {
  const height = useHeaderHeight();
  return Platform.OS === 'ios' ? height : 0;
}
