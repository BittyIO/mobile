import React, {useState} from 'react';
import {Keyboard, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View} from 'react-native';
import Svg, {Circle, Path} from 'react-native-svg';
import {Sheet} from '@/components/Sheet';
import {displaySymbol} from '@/core/format';
import {useNetwork, NETWORKS, NETWORK_LABEL, networkLabel} from '@/core/network-store';
import {LANGUAGES} from '@/core/language-store';
import {translate} from '@/i18n';
import type {Network} from '@/core/chain';
import {useColors, useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';

/** Three dots, the system's own mark for "more of this screen's actions". */
function MoreIcon({color}: {color: string}) {
  return (
    <Svg width={21} height={21} viewBox="0 0 24 24">
      <Circle cx={5} cy={12} r={1.9} fill={color} />
      <Circle cx={12} cy={12} r={1.9} fill={color} />
      <Circle cx={19} cy={12} r={1.9} fill={color} />
    </Svg>
  );
}

const glyph = (color: string) => ({
  stroke: color,
  strokeWidth: 1.9,
  fill: 'none' as const,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
});

/** lucide Share — a box with an arrow leaving it. */
function ShareIcon({color}: {color: string}) {
  const c = glyph(color);
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24">
      <Path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" {...c} />
      <Path d="M16 6l-4-4-4 4" {...c} />
      <Path d="M12 2v13" {...c} />
    </Svg>
  );
}

/** The same box with the arrow coming back in. */
function ImportIcon({color}: {color: string}) {
  const c = glyph(color);
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24">
      <Path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" {...c} />
      <Path d="M8 10l4 4 4-4" {...c} />
      <Path d="M12 2v12" {...c} />
    </Svg>
  );
}

/** lucide Trash2. */
function TrashIcon({color}: {color: string}) {
  const c = glyph(color);
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24">
      <Path d="M3 6h18" {...c} />
      <Path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" {...c} />
      <Path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" {...c} />
      <Path d="M10 11v6M14 11v6" {...c} />
    </Svg>
  );
}

/** How long the sheet takes to leave. Nothing may be presented over it until it has. */
const DISMISS_MS = 320;

/**
 * A shared list, as text: "Ethereum: WBTC, ETH, UNI, AAVE".
 *
 * The NETWORK leads, not the list's name. A ticker means nothing without the chain it is on —
 * cbBTC exists on Base and not on mainnet — so the chain is the one piece of context an importer
 * cannot guess, and the name of someone else's list is the one piece they do not need.
 *
 * The chain goes in CANONICALLY — `NETWORK_LABEL`, never the translated name. This text leaves
 * the app and is read by someone whose language is not the sender's: a list shared from a
 * Chinese phone said "以太坊: WBTC, ETH", which an English phone refused because it matches
 * against its own labels. The tickers are already language-independent; the chain has to be too.
 * What the sender SEES is still localised everywhere else in the app — this one string is an
 * interchange format, not a label.
 */
export const shareText = (network: Network, symbols: string[]) =>
  `${NETWORK_LABEL[network]}: ${symbols.map(displaySymbol).join(', ')}`;

/**
 * Parse text in that shape back into a chain and a set of tickers.
 *
 * Deliberately forgiving about everything except the chain: any separator run, any case, a
 * missing space. The chain is REQUIRED — `label` is null when the text names none, and the
 * caller refuses it — because importing a Base list onto mainnet would silently star the subset
 * of tickers that happen to exist on both, which is the one result nobody can check.
 */
/**
 * Every name a chain answers to: its canonical label, its own id, and its name in all fifteen
 * languages.
 *
 * Built once. The canonical label is what this app shares today, the id is what a machine would
 * write, and the translated names are what builds before this change put on the wire — a list
 * shared from a Chinese phone has to keep importing on an English one, so every label the app
 * has ever shown is accepted.
 */
const NETWORK_ALIASES: {network: Network; names: Set<string>}[] = NETWORKS.map((n) => ({
  network: n,
  names: new Set(
    [NETWORK_LABEL[n], n, ...LANGUAGES.map((l) => networkLabel(n, (k) => translate(l.code, k)))].map((x) =>
      x.toLowerCase(),
    ),
  ),
}));

export function parseShared(text: string): {network: Network | null; label: string | null; symbols: string[]} {
  const [head, ...rest] = text.split(':');
  const body = rest.length ? rest.join(':') : head;
  const named = rest.length ? head.trim() : '';
  const match = NETWORK_ALIASES.find((a) => a.names.has(named.toLowerCase()))?.network;
  return {
    network: match ?? null,
    label: named || null,
    symbols: body
      .split(/[,\s]+/)
      .map((x) => x.trim())
      .filter(Boolean),
  };
}

/**
 * The watch list's header-right: one ⋯ holding what can be done to the list itself.
 *
 * Share, Import, Delete. Share and Delete both leave this sheet — the system share sheet and the
 * delete confirmation are each their own Modal — so both wait for this one to finish dismissing
 * before they fire. Presenting a modal while another is still going away is dropped by iOS, which
 * is why Share crashed and Delete appeared to do nothing at all.
 *
 * Import stays inside this sheet and swaps its contents, for the same reason: a second sheet on
 * top of this one would never appear.
 *
 * Module scope, and rendered as `<WatchlistMenu />` rather than built inline inside
 * `setOptions`: the element's TYPE has to be stable across renders or react-navigation remounts
 * the header's right side on every options update.
 */
export function WatchlistMenu({
  label,
  symbols,
  canDelete,
  onDelete,
  onImport,
  importOnly,
}: {
  /** What the list is called on screen, for nothing but the share text's fallback. */
  label: string;
  symbols: string[];
  /** False for "Assets" and for the last remaining list — neither can be removed. */
  canDelete: boolean;
  /** Opens the confirmation; the menu never deletes on its own. */
  onDelete: () => void;
  /** Star these tickers onto the current list. Returns how many it recognised. */
  onImport: (symbols: string[]) => number;
  /**
   * Skip the menu and be the import button.
   *
   * A list being made has nothing to share and nothing to delete, so a ⋯ holding one row is a
   * tap spent on a menu. Pasting a list someone sent is also the likeliest reason to be on a
   * blank one at all, so on a draft the bar button IS the importer.
   */
  importOnly?: boolean;
}) {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const network = useNetwork((s) => s.network);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'menu' | 'import'>(importOnly ? 'import' : 'menu');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setOpen(false);
    setTimeout(() => {
      setMode(importOnly ? 'import' : 'menu');
      setDraft('');
      setError(null);
    }, DISMISS_MS);
  };

  /** Close, then do it — never both at once. See the note on the component. */
  const after = (run: () => void) => {
    setOpen(false);
    setTimeout(() => {
      setMode(importOnly ? 'import' : 'menu');
      run();
    }, DISMISS_MS);
  };

  const share = () => {
    if (symbols.length === 0) return;
    after(() => {
      Share.share({message: shareText(network, symbols)}).catch(() => {});
    });
  };

  const runImport = () => {
    Keyboard.dismiss();
    const parsed = parseShared(draft);
    /**
     * The chain is required, not inferred.
     *
     * Bare tickers used to import onto whatever was in front, which is the one outcome nobody
     * can check: the paste looks like it worked and the list is whatever the two chains happen
     * to share. A shared list always carries its chain — that is what the share text is for —
     * so text that does not is not a shared list, and saying so costs one more paste.
     */
    if (!parsed.label) {
      setError(t('mobile.home.import_needs_network', {network: networkLabel(network, t)}));
      return;
    }
    // A chain was named and it is not one we know, or not this one: say which.
    if (!parsed.network) {
      setError(t('mobile.home.import_wrong_network', {network: parsed.label}));
      return;
    }
    if (parsed.network !== network) {
      setError(t('mobile.home.import_wrong_network', {network: networkLabel(parsed.network, t)}));
      return;
    }
    if (onImport(parsed.symbols) === 0) {
      setError(t('mobile.home.import_none'));
      return;
    }
    close();
  };

  const rows = [
    ...(symbols.length > 0
      ? [{key: 'share', label: t('mobile.home.share_address'), icon: <ShareIcon color={c.subtext} />, onPress: share, danger: false}]
      : []),
    {
      key: 'import',
      label: t('mobile.home.import_list'),
      icon: <ImportIcon color={c.subtext} />,
      onPress: () => setMode('import'),
      danger: false,
    },
    ...(canDelete
      ? [
          {
            key: 'delete',
            label: t('mobile.home.delete_list'),
            icon: <TrashIcon color={c.danger} />,
            onPress: () => after(onDelete),
            danger: true,
          },
        ]
      : []),
  ];

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={styles.btn}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel={importOnly ? t('mobile.home.import_list') : t('mobile.trade.more')}>
        {importOnly ? <ImportIcon color={c.text} /> : <MoreIcon color={c.text} />}
      </Pressable>

      <Sheet
        visible={open}
        title={mode === 'import' ? t('mobile.home.import_list') : t('mobile.home.watch_list')}
        onClose={close}>
        <ScrollView showsVerticalScrollIndicator={false} style={styles.scroll} bounces={false} keyboardShouldPersistTaps="handled">
          {mode === 'import' ? (
            <View style={styles.card}>
              <TextInput
                style={styles.input}
                placeholder={t('mobile.home.import_hint')}
                placeholderTextColor={c.subtext}
                autoCapitalize="characters"
                autoCorrect={false}
                autoFocus
                multiline
                value={draft}
                onChangeText={(v) => {
                  setDraft(v);
                  setError(null);
                }}
              />
              {error ? <Text style={styles.error}>{error}</Text> : null}
              <Pressable
                style={({pressed}) => [styles.use, !draft.trim() && styles.useOff, pressed && styles.pressed]}
                disabled={!draft.trim()}
                onPress={runImport}>
                <Text style={[styles.useText, !draft.trim() && styles.useTextOff]}>{t('vault.confirm')}</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.card}>
              {rows.map((r, i) => (
                <Pressable
                  key={r.key}
                  style={({pressed}) => [styles.row, i === 0 && styles.rowFirst, i === rows.length - 1 && styles.rowLast, pressed && styles.pressed]}
                  onPress={r.onPress}>
                  {r.icon}
                  <Text style={[styles.label, r.danger && styles.labelDanger]}>{r.label}</Text>
                </Pressable>
              ))}
            </View>
          )}
        </ScrollView>
      </Sheet>
    </>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    /**
     * Sized to the bar's full 44, not to the glyph.
     *
     * The watch list is a PUSHED screen, and react-native-screens hands `headerRight` to a native
     * bar-button custom view anchored by its BOTTOM edge — so a 21pt mark in a 21pt box hangs low
     * in a 44pt bar. The 6pt is this screen's measured correction, carried over from the bin.
     */
    btn: {width: 44, height: 44, paddingBottom: 6, alignItems: 'center', justifyContent: 'center'},

    scroll: {flexGrow: 0},
    // The same card and row metrics the asset picker uses, so a sheet is a sheet.
    card: {backgroundColor: c.card, borderRadius: 20, paddingHorizontal: 16},
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      minHeight: 56,
      paddingVertical: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
    },
    rowFirst: {borderTopWidth: 0, paddingTop: 16},
    rowLast: {paddingBottom: 16},
    pressed: {opacity: 0.6},
    label: {color: c.text, fontSize: 16, fontWeight: '600', flex: 1},
    labelDanger: {color: c.danger},

    input: {
      minHeight: 72,
      borderRadius: 12,
      backgroundColor: c.input,
      color: c.text,
      paddingHorizontal: 12,
      paddingTop: 12,
      paddingBottom: 12,
      fontSize: 15,
      marginTop: 16,
      textAlignVertical: 'top',
    },
    error: {color: c.danger, fontSize: 12, lineHeight: 17, marginTop: 8},
    use: {height: 44, borderRadius: 12, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center', marginVertical: 16},
    useOff: {backgroundColor: c.neutralSoft},
    useText: {color: '#fff', fontSize: 15, fontWeight: '700'},
    useTextOff: {color: c.subtext},
  });
