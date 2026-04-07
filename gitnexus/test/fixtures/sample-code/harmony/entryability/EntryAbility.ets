/**
 * ArkUI EntryAbility fixture — HarmonyOS application lifecycle.
 * Used by tree-sitter-languages.test.ts for class/method extraction tests.
 */

import UIAbility from '@ohos.app.ability.UIAbility';
import window from '@ohos.window';

export default class EntryAbility extends UIAbility {
  onCreate(want: object, launchParam: object) {
    console.info('EntryAbility onCreate: ' + JSON.stringify(want));
  }

  onWindowStageCreate(windowStage: window.WindowStage) {
    windowStage.loadContent('pages/Index', (err, data) => {
      if (err.code) {
        console.error('loadContent error: ' + JSON.stringify(err));
        return;
      }
      console.info('loadContent success: ' + JSON.stringify(data));
    });
  }

  onWindowStageDestroy() {
    console.info('EntryAbility onWindowStageDestroy');
  }

  onForeground() {
    console.info('EntryAbility onForeground');
  }

  onBackground() {
    console.info('EntryAbility onBackground');
  }

  onDestroy() {
    console.info('EntryAbility onDestroy');
  }
}
