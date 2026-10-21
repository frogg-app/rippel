import type { ManagedUser } from '@comfy/shared';
import { request } from './api';
export type UserPermissions = Pick<ManagedUser, 'role' | 'settingsAccess' | 'suspended' | 'generationEnabled' | 'maxQueuedJobs' | 'dailyGenerationLimit'>;
export interface UsersApi {
  remove(id: string): Promise<void>;
  list(signal?: AbortSignal): Promise<ManagedUser[]>;
  create(body: { email: string; displayName: string; password: string }): Promise<ManagedUser>;
  update(id: string, body: UserPermissions): Promise<ManagedUser>;
}
export const usersApi: UsersApi = {
  remove: id => request<void>(`/users/${id}`, { method: 'DELETE' }),
  list: async signal => (await request<{ users: ManagedUser[] }>('/users', { signal })).users,
  create: async body => (await request<{ user: ManagedUser }>('/users', { method: 'POST', body })).user,
  update: async (id, body) => (await request<{ user: ManagedUser }>(`/users/${id}`, { method: 'PATCH', body })).user,
};
