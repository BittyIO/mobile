import React from 'react';
import {ScrollView, StyleSheet, Text, useWindowDimensions, View} from 'react-native';
import {Sheet} from '@/components/Sheet';
import {TERMS, TERMS_UPDATED} from '@/core/terms';
import {useT} from '@/i18n';
import {useStyles, type Colors} from '@/theme';

/** `**bold**` runs as nested Text; the Terms use no other markup. */
function Rich({text, style, bold}: {text: string; style: object; bold: object}) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return (
    <Text style={style}>
      {parts.map((p, i) =>
        p.startsWith('**') && p.endsWith('**') ? (
          <Text key={i} style={bold}>
            {p.slice(2, -2)}
          </Text>
        ) : (
          p
        ),
      )}
    </Text>
  );
}

/**
 * Settings › Terms of Use: the Terms in a sheet that scrolls, read in the app rather than on the
 * website. The text ships with the app (core/terms), so it opens offline and is the version this
 * build was released with.
 */
export function TermsSheet({visible, onClose}: {visible: boolean; onClose: () => void}) {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const {height} = useWindowDimensions();
  return (
    <Sheet visible={visible} title={t('mobile.settings.terms_of_use')} onClose={onClose} height={Math.round(height * 0.85)}>
      <ScrollView showsVerticalScrollIndicator contentContainerStyle={styles.body}>
        <Text style={styles.updated}>{t('mobile.settings.terms_updated', {date: new Date(`${TERMS_UPDATED}T00:00:00`).toLocaleDateString()})}</Text>
        {TERMS.map((s) => (
          <View key={s.title} style={styles.section}>
            <Text style={styles.heading}>{s.title}</Text>
            {s.blocks.map((b, i) =>
              b.type === 'p' ? (
                <Rich key={i} text={b.text} style={styles.p} bold={styles.bold} />
              ) : (
                <View key={i} style={styles.list}>
                  {b.items.map((it, j) => (
                    <View key={j} style={styles.item}>
                      <Text style={styles.marker}>{b.type === 'ol' ? `${j + 1}.` : '•'}</Text>
                      <Rich text={it} style={[styles.p, styles.itemText]} bold={styles.bold} />
                    </View>
                  ))}
                </View>
              ),
            )}
          </View>
        ))}
      </ScrollView>
    </Sheet>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    body: {paddingBottom: 32, gap: 20},
    updated: {color: c.subtext, fontSize: 12},
    section: {gap: 8},
    heading: {color: c.text, fontSize: 16, fontWeight: '700'},
    p: {color: c.text, fontSize: 14, lineHeight: 20},
    bold: {fontWeight: '700'},
    list: {gap: 6},
    item: {flexDirection: 'row', gap: 8},
    marker: {color: c.subtext, fontSize: 14, lineHeight: 20, minWidth: 16},
    itemText: {flex: 1},
  });
