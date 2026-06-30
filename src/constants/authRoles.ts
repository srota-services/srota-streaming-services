export const AuthRole = {
   LISTENER: 'LISTENER',
   GLOBAL_ADMIN: 'GLOBAL_ADMIN',
   ORG_ADMIN: 'ORG_ADMIN',
   ORG_COORDINATOR: 'ORG_COORDINATOR',
   AUTHOR: 'AUTHOR',
   GUEST: 'GUEST',
} as const;

export type AuthRoleValue = (typeof AuthRole)[keyof typeof AuthRole];

export function normalizeAuthRole(role: string | undefined): string {
   return (role ?? '').trim().toLowerCase();
}

export function isGuestRole(role: string | undefined): boolean {
   return normalizeAuthRole(role) === normalizeAuthRole(AuthRole.GUEST);
}

export function isListenerRole(role: string | undefined): boolean {
   return normalizeAuthRole(role) === normalizeAuthRole(AuthRole.LISTENER);
}
