// Polyfills FIRST — viem/crypto touch globals that Hermes does not ship.
import './src/polyfills';
import 'react-native-gesture-handler';
// Before anything renders: caps how far the system text size scales the app's text.
import './src/core/text-scale';

import {AppRegistry} from 'react-native';
import App from './src/App';
import {name as appName} from './app.json';

AppRegistry.registerComponent(appName, () => App);
