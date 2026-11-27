import React, {useState} from 'react';
import {Pressable, StyleSheet, Text, TextInput, type StyleProp, type TextStyle} from 'react-native';
import {useColors} from '@/theme';

/**
 * An address field that, at rest, shows a whole address shortened in the middle (T1234…abcd), so
 * both ends can be checked at a glance; tapping it edits the full text. While it is being edited,
 * or holds no valid address yet, it is a plain input.
 */
export function AddressInput({
  value,
  onChangeText,
  placeholder,
  valid,
  style,
  editable = true,
}: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  /** The text is a whole address: only then is it shortened. */
  valid: boolean;
  style?: StyleProp<TextStyle>;
  editable?: boolean;
}) {
  const c = useColors();
  const [editing, setEditing] = useState(false);
  if (editing || !valid || !value) {
    return (
      <TextInput
        style={style}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={c.subtext}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus={editing}
        editable={editable}
        onFocus={() => setEditing(true)}
        onBlur={() => setEditing(false)}
      />
    );
  }
  return (
    <Pressable style={styles.fill} onPress={() => editable && setEditing(true)} accessibilityRole="button" accessibilityLabel={value}>
      <Text style={style} numberOfLines={1} ellipsizeMode="middle">
        {value}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({fill: {flex: 1}});
