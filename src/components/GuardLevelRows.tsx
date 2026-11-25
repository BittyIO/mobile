import React, {useEffect, useRef, useState} from 'react';
import {Animated, Easing, StyleSheet, Text, View} from 'react-native';
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
  onCustom,
  custom,
  disabled,
  loading,
}: {
  selected: GuardChoice | null;
  onSelect: (choice: GuardChoice) => void;
  /** Custom opens its own page instead of being chosen here. */
  onCustom?: () => void;
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
          // The security delay beside the name; the panel under the chosen level has the two limits.
          // "Security delay 7 days"; None reads "0 days", not a second "None" after the name.
          titleNote={(() => {
            const lock = (l === 'custom' ? custom! : GUARD_LEVELS[l]).timelock;
            const days = lock > 0n ? fmtRiskValue('timelock', lock, t) : t('mobile.vault.duration_days', {n: 0});
            return `${t(RISK_TITLE.timelock)} ${days}`;
          })()}
          // Who each level is for — Highest is for earning only.
          sub={t(`mobile.vault.guard_level_${l}_for`)}
          // The chosen level shows what it sets, under its name.
          below={
            <Expand open={selected === l}>
              <LevelValues values={l === 'custom' ? custom! : GUARD_LEVELS[l]} />
            </Expand>
          }
          // Under the title, past the 30-point shield and the row's 12-point gap.
          belowIndent={42}
          checked={selected === l}
          loading={loading === l}
          disabled={disabled}
          onPress={() => (l === 'custom' && onCustom ? onCustom() : onSelect(l))}
          last={i === choices.length - 1}
        />
      ))}
    </>
  );
}

/**
 * Opens and closes its content by animating its height (and fading it), measured off the content's
 * natural size, so a level's values slide in under it when chosen and away when another is.
 */
function Expand({open, children}: {open: boolean; children: React.ReactNode}) {
  const [h, setH] = useState(0);
  const anim = useRef(new Animated.Value(open ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(anim, {toValue: open ? 1 : 0, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: false}).start();
  }, [open, anim]);
  return (
    <Animated.View style={{height: anim.interpolate({inputRange: [0, 1], outputRange: [0, h]}), opacity: anim, overflow: 'hidden'}}>
      <View style={expandStyles.measure} onLayout={(e) => setH(e.nativeEvent.layout.height)}>
        {children}
      </View>
    </Animated.View>
  );
}

const expandStyles = StyleSheet.create({measure: {position: 'absolute', top: 0, left: 0, right: 0}});

/** A level's three values as lines under its name: the timelock and both daily limits. */
function LevelValues({values}: {values: GuardValues}) {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.values}>
      {FIELDS.filter(({field}) => field !== 'timelock').map(({field}) => (
        <View key={field} style={styles.valueLine}>
          <Text style={styles.valueLabel} numberOfLines={2}>
            {t(RISK_TITLE[field])}
          </Text>
          <Text style={styles.valueText}>{fmtRiskValue(field, values[field], t)}</Text>
        </View>
      ))}
      {values.marketTradeDailyLossAllowance === 0n ? <Text style={styles.valueNote}>{t('mobile.vault.guard_loss_off')}</Text> : null}
    </View>
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
    // A surface one step off the card, so the chosen level's values read as its own panel.
    values: {marginTop: 10, gap: 6, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12, backgroundColor: c.cardAlt},
    valueLine: {flexDirection: 'row', justifyContent: 'space-between', gap: 8},
    valueLabel: {color: c.subtext, fontSize: 12, flexShrink: 1},
    valueText: {color: c.text, fontSize: 12, fontWeight: '600', textAlign: 'right'},
    valueNote: {color: c.subtext, fontSize: 12, fontStyle: 'italic'},
    about: {gap: 12, paddingHorizontal: 4, paddingBottom: 24},
    aboutText: {color: c.text, fontSize: 15, lineHeight: 22},
    aboutSub: {color: c.subtext, fontSize: 13, lineHeight: 19},
  });
