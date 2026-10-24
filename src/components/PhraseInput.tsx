import React, {useMemo, useRef, useState} from 'react';
import {InputAccessoryView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {wordlist} from '@scure/bip39/wordlists/english';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';

const WORDS = new Set(wordlist);
const ACCESSORY = 'phrase-suggestions';
const MAX_SUGGESTIONS = 8;

/**
 * A recovery phrase entered word by word: 12 or 24 numbered fields, one word each.
 *
 * Typing the first letters of a word lists the BIP-39 words that start with them in a bar over the
 * keyboard; tapping one fills the field and moves on, so a word is two or three letters and a tap.
 * A space or Return accepts the word as typed (or the only word its letters can still be) and moves
 * on too. A field holding something that is not a BIP-39 word turns red.
 *
 * A whole phrase pasted into any field is spread across the fields from that one, and a pasted
 * 24-word phrase switches the count to 24.
 */
export function PhraseInput({
  words,
  count,
  onChange,
  onCount,
}: {
  /** Always 24 long; the first `count` are the phrase. */
  words: string[];
  count: 12 | 24;
  onChange: (words: string[]) => void;
  onCount: (n: 12 | 24) => void;
}) {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const refs = useRef<(TextInput | null)[]>([]);
  const [focus, setFocus] = useState<number | null>(null);

  const typed = focus != null ? words[focus] ?? '' : '';
  const suggestions = useMemo(() => {
    if (!typed) return [];
    return wordlist.filter((w) => w.startsWith(typed)).slice(0, MAX_SUGGESTIONS);
  }, [typed]);

  const next = (i: number) => {
    if (i + 1 < count) refs.current[i + 1]?.focus();
    else refs.current[i]?.blur();
  };

  const set = (i: number, w: string) => {
    const out = [...words];
    out[i] = w;
    onChange(out);
  };

  const pick = (i: number, w: string) => {
    set(i, w);
    next(i);
  };

  const onText = (i: number, raw: string) => {
    const text = raw.toLowerCase().replace(/[^a-z\s]/g, '');
    const parts = text.trim().split(/\s+/).filter(Boolean);
    // A paste of several words: spread them from this field on.
    if (parts.length > 1) {
      const total = i + parts.length > 12 ? 24 : count;
      const out = [...words];
      parts.slice(0, 24 - i).forEach((w, k) => (out[i + k] = w));
      if (total !== count) onCount(total);
      onChange(out);
      refs.current[Math.min(i + parts.length, total) - 1]?.blur();
      return;
    }
    const word = parts[0] ?? '';
    // A space typed after the letters: accept the word, or the only word they can still become.
    if (/\s$/.test(text) && word) {
      const only = wordlist.filter((w) => w.startsWith(word));
      pick(i, WORDS.has(word) ? word : only.length === 1 ? only[0] : word);
      return;
    }
    set(i, word);
  };

  const onSubmit = (i: number) => {
    const word = words[i];
    const only = word ? wordlist.filter((w) => w.startsWith(word)) : [];
    if (word && !WORDS.has(word) && only.length === 1) set(i, only[0]);
    next(i);
  };

  const bar = (
    <View style={styles.bar}>
      <ScrollView horizontal keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false} contentContainerStyle={styles.barRow}>
        {suggestions.map((w) => (
          <Pressable key={w} style={styles.suggestion} onPress={() => focus != null && pick(focus, w)}>
            <Text style={styles.suggestionText}>{w}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );

  return (
    <View style={styles.wrap}>
      <View style={styles.counts}>
        {([12, 24] as const).map((n) => (
          <Pressable key={n} style={[styles.count, count === n && styles.countOn]} onPress={() => onCount(n)}>
            <Text style={[styles.countText, count === n && styles.countTextOn]}>{t('mobile.payments.onboarding_n_words', {n})}</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.grid}>
        {Array.from({length: count}, (_, i) => {
          const w = words[i] ?? '';
          const bad = !!w && focus !== i && !WORDS.has(w);
          return (
            <View key={i} style={[styles.cell, focus === i && styles.cellFocus, bad && styles.cellBad]}>
              <Text style={styles.idx}>{i + 1}</Text>
              <TextInput
                ref={(r) => {
                  refs.current[i] = r;
                }}
                style={[styles.field, bad && styles.fieldBad]}
                value={w}
                onChangeText={(x) => onText(i, x)}
                onFocus={() => setFocus(i)}
                onBlur={() => setFocus((f) => (f === i ? null : f))}
                onSubmitEditing={() => onSubmit(i)}
                returnKeyType={i + 1 < count ? 'next' : 'done'}
                blurOnSubmit={false}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
                spellCheck={false}
                textContentType="none"
                keyboardType={Platform.OS === 'ios' ? 'ascii-capable' : 'visible-password'}
                inputAccessoryViewID={ACCESSORY}
                placeholderTextColor={c.subtext}
              />
            </View>
          );
        })}
      </View>
      {Platform.OS === 'ios' ? (
        <InputAccessoryView nativeID={ACCESSORY}>{bar}</InputAccessoryView>
      ) : suggestions.length > 0 ? (
        bar
      ) : null}
    </View>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    wrap: {gap: 12},
    counts: {flexDirection: 'row', alignSelf: 'flex-start', backgroundColor: c.cardAlt, borderRadius: 10, padding: 3},
    count: {paddingVertical: 6, paddingHorizontal: 14, borderRadius: 8},
    countOn: {backgroundColor: c.accent},
    countText: {color: c.text, fontSize: 13, fontWeight: '600'},
    countTextOn: {color: c.onAccent},
    grid: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between'},
    cell: {
      width: '31%',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      backgroundColor: c.card,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: 'transparent',
      paddingHorizontal: 8,
    },
    cellFocus: {borderColor: c.accent},
    cellBad: {borderColor: c.danger},
    idx: {color: c.subtext, fontSize: 11, width: 16},
    field: {flex: 1, color: c.text, fontSize: 14, fontWeight: '600', paddingVertical: 10},
    fieldBad: {color: c.danger},
    bar: {backgroundColor: c.elevated, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border, minHeight: 44},
    barRow: {gap: 8, paddingHorizontal: 8, paddingVertical: 6, alignItems: 'center'},
    suggestion: {backgroundColor: c.cardAlt, borderRadius: 8, paddingVertical: 7, paddingHorizontal: 12},
    suggestionText: {color: c.text, fontSize: 15, fontWeight: '600'},
  });
