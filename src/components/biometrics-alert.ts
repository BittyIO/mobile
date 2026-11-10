import {Alert, Linking, Platform} from 'react-native';
import {BiometricsRequiredError} from '@/wallet/keyring';

type T = (key: string) => string;

/**
 * When saving or opening the key failed because no Face ID / fingerprint can protect it, say so and
 * offer the way there; returns whether it was that. Without it every such failure was reported by
 * whatever the caller's generic title was. On restore, that title was "Invalid recovery phrase", for
 * twelve words that were perfectly valid.
 *
 * iOS: Bitty's own page in Settings, which holds its "Face ID" switch and leads on to Face ID &
 * Passcode. Android: Security, where a fingerprint or face unlock is enrolled.
 */
export function alertIfBiometricsRequired(e: unknown, t: T): boolean {
  if (!(e instanceof BiometricsRequiredError)) return false;
  const open = () =>
    Platform.OS === 'android'
      ? Linking.sendIntent('android.settings.SECURITY_SETTINGS').catch(() => Linking.openSettings())
      : Linking.openSettings();
  Alert.alert(t(Platform.OS === 'ios' ? 'mobile.app.biometrics_title_ios' : 'mobile.app.biometrics_title'), e.message, [
    {text: t('common.cancel'), style: 'cancel'},
    {text: t('mobile.scan.open_settings'), onPress: () => void open()},
  ]);
  return true;
}
