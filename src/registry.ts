/**
 * Реестр privacy-компонентов.
 * Хранит компоненты и флаги enabled; resolveOrder даёт топологический порядок.
 */

import type { PrivacyComponent } from './types';

interface Entry {
  component: PrivacyComponent;
  enabled: boolean;
}

export class ComponentRegistry {
  private entries = new Map<string, Entry>();

  register(c: PrivacyComponent): void {
    this.entries.set(c.id, { component: c, enabled: false });
  }

  get(id: string): PrivacyComponent | undefined {
    return this.entries.get(id)?.component;
  }

  list(): PrivacyComponent[] {
    return [...this.entries.values()].map(e => e.component);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  setEnabled(id: string, on: boolean): void {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Компонент "${id}" не зарегистрирован`);
    entry.enabled = on;
  }

  isEnabled(id: string): boolean {
    return this.entries.get(id)?.enabled ?? false;
  }

  /**
   * Топологический порядок включённых компонентов по зависимостям (requires).
   * Бросает ошибку на цикле или отсутствующей зависимости включённого компонента.
   */
  resolveOrder(): PrivacyComponent[] {
    const enabled = [...this.entries.values()]
      .filter(e => e.enabled)
      .map(e => e.component);

    // Проверяем, что все requires включённых существуют в реестре
    for (const c of enabled) {
      for (const dep of c.requires ?? []) {
        if (!this.entries.has(dep)) {
          throw new Error(
            `Компонент "${c.id}" требует "${dep}", который не зарегистрирован`
          );
        }
        if (!this.isEnabled(dep)) {
          throw new Error(
            `Компонент "${c.id}" требует "${dep}", который не включён`
          );
        }
      }
    }

    // Kahn's algorithm — топологическая сортировка
    const ids = new Set(enabled.map(c => c.id));
    const inDegree = new Map<string, number>();
    const adj = new Map<string, string[]>(); // dep → [dependents]

    for (const c of enabled) {
      inDegree.set(c.id, c.requires?.filter(r => ids.has(r)).length ?? 0);
      for (const dep of c.requires ?? []) {
        if (!ids.has(dep)) continue;
        if (!adj.has(dep)) adj.set(dep, []);
        adj.get(dep)!.push(c.id);
      }
    }

    const queue: string[] = [];
    for (const c of enabled) {
      if ((inDegree.get(c.id) ?? 0) === 0) queue.push(c.id);
    }

    const sorted: string[] = [];
    while (queue.length) {
      const id = queue.shift()!;
      sorted.push(id);
      for (const dep of adj.get(id) ?? []) {
        const deg = (inDegree.get(dep) ?? 0) - 1;
        inDegree.set(dep, deg);
        if (deg === 0) queue.push(dep);
      }
    }

    if (sorted.length !== enabled.length) {
      throw new Error('Обнаружен цикл в зависимостях privacy-компонентов');
    }

    const byId = new Map(enabled.map(c => [c.id, c]));
    return sorted.map(id => byId.get(id)!);
  }
}
