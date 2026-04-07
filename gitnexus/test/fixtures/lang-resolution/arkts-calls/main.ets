/**
 * ArkTS entry point — imports from both service and utils.
 */
import { createGreeting, normalizeAndGreet } from './service';

@Entry
@Component
struct MainPage {
  @State message: string = '';

  aboutToAppear() {
    this.message = normalizeAndGreet('  HarmonyOS  ');
  }

  build() {
    Column() {
      Text(this.message);
    }
  }
}

export function runApp(): string {
  return createGreeting('World');
}
