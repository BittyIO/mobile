import type {Language} from '@/core/language-store';

// Strings the mobile app needs that the web files do not have. One module per screen (or shared
// component), each exporting a table keyed by language then by key, registered here under the
// namespace used in `t("mobile.<ns>.<key>")`. Every table carries all eight languages.
export type MobileTable = Partial<Record<Language, Record<string, string>>> & {en: Record<string, string>};

import {settings} from './settings';
import {app} from './app';
import {payments} from './payments';
import {vault} from './vault';
import {home} from './home';
import {trade} from './trade';
import {earn} from './earn';
import {actions} from './actions';
import {safe} from './safe';

export const MOBILE_STRINGS: Record<string, MobileTable> = {
  settings,
  app,
  payments,
  home,
  vault,
  trade,
  earn,
  actions,
  safe,
};
