import React from 'react';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {RootStackParamList} from '@/App';
import {OnboardingScreen} from '@/screens/OnboardingScreen';

/**
 * Security › Recovery phrases › Create / Import: onboarding's own two flows, adding a phrase beside
 * the ones already here. Done (or Back from the first step) returns to the list.
 */
export function AddRecoveryPhraseScreen() {
  const nav = useNavigation();
  const {mode} = useRoute<RouteProp<RootStackParamList, 'AddRecoveryPhrase'>>().params;
  return <OnboardingScreen add={{mode, onDone: () => nav.goBack()}} />;
}
