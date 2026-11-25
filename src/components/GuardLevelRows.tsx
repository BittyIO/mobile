import React, {useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {OptionRow, SettingsGroup, SettingsRow} from '@/components/SettingsRow';
import {Sheet} from '@/components/Sheet';
import {useVaultGate} from '@/vault/gate';
import {isOpenRiskVersion} from '@/vault/risk';
import {versionAtLeast} from '@/vault/capabilities';
import {BRIDGE_SINCE} from '@/vault/bridge';
import {useStyles, type Colors} from '@/theme';
import {GuardShield} from '@/components/GuardShield';
import {RISK_TITLE, fmtRiskValue, riskHintKey, riskWhyKey} from '@/components/riskFormat';
import {GUARD_LEVELS, GUARD_LEVEL_LIST, guardShieldOf, type GuardLevel, type GuardValues} from '@/core/new-vault-defaults';
import {useT} from '@/i18n';

export type GuardChoice = GuardLevel | 'custom';

/**
 * The Guard levels as choices, each with its shield, on Guard › Guard level (with Custom).
 */
export function GuardLevelRows({
  selected,
  onSelect,
  custom,
  disabled,
  loading,
}: {
  selected: GuardChoice | null;
  onSelect: (choice: GuardChoice) => void;
  /** Offer Custom, its shield the one `custom` earns. */
  custom?: GuardValues;
  disabled?: boolean;
  /** The choice being written: a spinner in place of its mark. */
  loading?: GuardChoice | null;
}) {
  const {t} = useT();
  const choices: GuardChoice[] = custom ? [...GUARD_LEVEL_LIST, 'custom'] : GUARD_LEVEL_LIST;
  return (
    <>
      {choices.map((l, i) => (
        <OptionRow
          key={String(l)}
          leading={<GuardShield level={guardShieldOf(l === 'custom' ? custom! : GUARD_LEVELS[l])} size={30} />}
          title={t(`mobile.vault.guard_level_${l}`)}
          checked={selected === l}
          loading={loading === l}
          disabled={disabled}
          onPress={() => onSelect(l)}
          last={i === choices.length - 1}
        />
      ))}
    </>
  );
}

type Field = keyof GuardValues;
const FIELDS: {field: Field; icon: 'timelock' | 'sendNew' | 'dailyLimit'}[] = [
  {field: 'timelock', icon: 'timelock'},
  {field: 'sendDailyAllowance', icon: 'sendNew'},
  {field: 'marketTradeDailyLossAllowance', icon: 'dailyLimit'},
];

/**
 * What a level sets: the timelock and both daily limits, each with an ⓘ explaining it as its own page
 * does. With `onEdit` (Custom) each row opens a choice.
 */
export function GuardParams({values, onEdit}: {values: GuardValues; onEdit?: (field: Field) => void}) {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const version = useVaultGate().vaultVersion;
  const open = isOpenRiskVersion(version);
  const bridges = versionAtLeast(version, BRIDGE_SINCE);
  const [about, setAbout] = useState<Field | null>(null);
  return (
    <>
      <Sheet visible={about !== null} title={about ? t(RISK_TITLE[about]) : ''} onClose={() => setAbout(null)}>
        {about ? (
          <View style={styles.about}>
            <Text style={styles.aboutText}>{t(riskWhyKey(about, bridges))}</Text>
            <Text style={styles.aboutSub}>{t(riskHintKey(about, bridges, open))}</Text>
          </View>
        ) : null}
      </Sheet>
      <SettingsGroup>
      {FIELDS.map(({field, icon}, i) => (
        <SettingsRow
          key={field}
          icon={icon}
          title={t(RISK_TITLE[field])}
          value={fmtRiskValue(field, values[field], t)}
          // $0 of losses a day is no market trade at all: the vault turns trading and bridging off with it.
          sub={field === 'marketTradeDailyLossAllowance' && values[field] === 0n ? t('mobile.vault.guard_loss_off') : undefined}
          onPress={onEdit ? () => onEdit(field) : undefined}
          chevron={!!onEdit}
          info={() => setAbout(field)}
          last={i === FIELDS.length - 1}
        />
      ))}
      </SettingsGroup>
    </>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    about: {gap: 12, paddingHorizontal: 4, paddingBottom: 24},
    aboutText: {color: c.text, fontSize: 15, lineHeight: 22},
    aboutSub: {color: c.subtext, fontSize: 13, lineHeight: 19},
  });
