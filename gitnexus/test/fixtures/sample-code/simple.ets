interface ArkUser {
  id: string;
  name: string;
}

@Entry
@Component
struct ArkSession {
  private user: ArkUser;

  constructor(user: ArkUser) {
    this.user = user;
  }

  getDisplayName(): string {
    return this.user.name;
  }
}

export function createSession(user: ArkUser): ArkSession {
  return new ArkSession(user);
}
