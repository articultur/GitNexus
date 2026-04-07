import relationalStore from '@ohos.data.relationalStore';
import preferences from '@ohos.data.preferences';

export class UserStore {
  async loadUsers(store: relationalStore.RdbStore): Promise<void> {
    const predicates = new relationalStore.RdbPredicates('users');
    await store.query(predicates, ['id', 'name']);
  }

  async loadAuditLogs(store: relationalStore.RdbStore): Promise<void> {
    await store.querySql('SELECT * FROM audit_logs');
    await store.executeSql('UPDATE audit_logs SET synced = 1');
  }

  async readTheme(context: Object): Promise<void> {
    const prefs = await preferences.getPreferences(context, 'settings');
    await prefs.get('theme', 'light');
  }
}