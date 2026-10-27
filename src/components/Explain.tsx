import React, {useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import Svg, {Circle, Path} from 'react-native-svg';
import {EXPLAIN_POINTS, type ExplainId} from '@/core/explainers';
import {Sheet} from '@/components/Sheet';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';

export type {ExplainId};

/**
 * An ⓘ that opens a short explanation of something the screen cannot say in a line: a title and
 * two to four numbered points, in a sheet.
 *
 * Every explanation lives under `mobile.explain.<id>` (title, p1…pN), written once for both apps
 * (the web has the same ids under `explain.<id>` — see core/explainers). The number of points is
 * fixed per id there, so a language that is missing one shows the English rather than a gap.
 */
export function Explain({id, size = 17}: {id: ExplainId; size?: number}) {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const [open, setOpen] = useState(false);
  const title = t(`mobile.explain.${id}.title`);
  return (
    <>
      <Pressable onPress={() => setOpen(true)} hitSlop={10} accessibilityRole="button" accessibilityLabel={title}>
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Circle cx={12} cy={12} r={10} stroke={c.subtext} strokeWidth={2} fill="none" />
          <Path d="M12 16v-4M12 8h.01" stroke={c.subtext} strokeWidth={2.2} strokeLinecap="round" />
        </Svg>
      </Pressable>
      <Sheet visible={open} title={title} onClose={() => setOpen(false)}>
        <View style={styles.card}>
          {Array.from({length: EXPLAIN_POINTS[id]}, (_, i) => (
            <View key={i} style={styles.point}>
              <View style={styles.num}>
                <Text style={styles.numText}>{i + 1}</Text>
              </View>
              <Text style={styles.text}>{t(`mobile.explain.${id}.p${i + 1}`)}</Text>
            </View>
          ))}
        </View>
      </Sheet>
    </>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    card: {backgroundColor: c.card, borderRadius: 20, padding: 16, gap: 14},
    point: {flexDirection: 'row', alignItems: 'flex-start', gap: 12},
    num: {width: 22, height: 22, borderRadius: 11, backgroundColor: c.accentSoft, alignItems: 'center', justifyContent: 'center', marginTop: 1},
    numText: {color: c.accent, fontSize: 12, fontWeight: '700'},
    text: {flex: 1, color: c.text, fontSize: 15, lineHeight: 21},
  });
