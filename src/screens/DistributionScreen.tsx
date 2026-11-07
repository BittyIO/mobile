import React from 'react';
import {ScrollView, StyleSheet, View} from 'react-native';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {PortfolioPie} from '@/components/PortfolioPie';
import {SettingsGroup, SettingsRow} from '@/components/SettingsRow';
import {useT} from '@/i18n';
import {useStyles, type Colors} from '@/theme';

/**
 * How the vault's holdings split — pushed from the pie on the Overview's total.
 *
 * The donut, then a second group with a Positions row that pushes every holding's position on a
 * page of its own ({PositionsScreen}). The holdings arrive as the Overview had them when it was
 * tapped (see the route's params), so the donut matches the total the user just read, and they are
 * passed on to Positions as they are.
 */
export function DistributionScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const params = useRoute<RouteProp<RootStackParamList, 'Distribution'>>().params;

  return (
    <ScrollView
      style={styles.container}
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      contentContainerStyle={styles.body}>
      <View style={styles.card}>
        <PortfolioPie slices={params.held} total={params.total} />
      </View>
      <SettingsGroup>
        <SettingsRow icon="assets" title={t('vault.positions')} onPress={() => nav.navigate('Positions', params)} last />
      </SettingsGroup>
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    // The Earn and Overview cards' frame: 16 between cards, 20 on top inside one, 16 elsewhere.
    body: {padding: 16, gap: 20, paddingBottom: 40},
    card: {backgroundColor: c.card, borderRadius: 20, padding: 16, paddingTop: 20, gap: 16},
  });
