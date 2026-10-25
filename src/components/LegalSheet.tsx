import React, {useEffect, useState} from 'react';
import {Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {TERMS, TERMS_UPDATED, type TermsSection} from '@/core/terms';
import {PRIVACY, PRIVACY_UPDATED} from '@/core/privacy';
import {useT} from '@/i18n';
import {useStyles, type Colors} from '@/theme';

/** `**bold**` runs as nested Text; the documents use no other markup. */
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

const DOCS: Record<'terms' | 'privacy', {title: string; updated: string; sections: TermsSection[]}> = {
  terms: {title: 'mobile.settings.terms_of_use', updated: TERMS_UPDATED, sections: TERMS},
  privacy: {title: 'mobile.settings.privacy_policy', updated: PRIVACY_UPDATED, sections: PRIVACY},
};

/**
 * Settings › Terms of Use and Privacy Policy: the document in a sheet that scrolls, read in the app
 * rather than on the website. The text ships with the app (core/terms, core/privacy), so it opens
 * offline and is the version this build was released with.
 *
 * Its own modal rather than the shared {Sheet}: there the card is a tap-swallowing Pressable inside
 * a backdrop Pressable, with a swipe-down to close, and this one long scroll view could not be
 * scrolled through all of that. Here nothing touchable wraps the text — the backdrop is a sibling
 * behind the card — and it closes with ✕ or a tap on the backdrop, never a swipe.
 */
export function LegalSheet({doc, onClose}: {doc: 'terms' | 'privacy' | null; onClose: () => void}) {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const {height} = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // The last one shown stays put while the sheet slides away.
  const [shown, setShown] = useState(doc ?? 'terms');
  useEffect(() => {
    if (doc) setShown(doc);
  }, [doc]);
  const {title, updated, sections} = DOCS[doc ?? shown];
  return (
    <Modal visible={!!doc} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.root}>
        <Pressable style={[StyleSheet.absoluteFill, styles.shade]} onPress={onClose} accessibilityLabel={t('common.close')} />
        <View style={[styles.card, {height: Math.round(height * 0.85), paddingBottom: insets.bottom}]}>
          <View style={styles.head}>
            <Text style={styles.title}>{t(title)}</Text>
            <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button">
              <Text style={styles.close}>✕</Text>
            </Pressable>
          </View>
          <ScrollView style={styles.scroll} showsVerticalScrollIndicator contentContainerStyle={styles.body}>
            <Text style={styles.updated}>
              {t('mobile.settings.terms_updated', {
                date: new Date(`${updated}T00:00:00`).toLocaleDateString(),
              })}
            </Text>
            {sections.map((s) => (
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
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    root: {flex: 1, justifyContent: 'flex-end'},
    shade: {backgroundColor: c.overlay},
    card: {
      backgroundColor: c.elevated,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
    },
    head: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingTop: 20,
      paddingBottom: 12,
    },
    title: {color: c.text, fontSize: 18, fontWeight: '700'},
    close: {color: c.subtext, fontSize: 18},
    scroll: {flex: 1, paddingHorizontal: 20},
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
