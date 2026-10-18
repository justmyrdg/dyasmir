import { HttpClient } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { Section, Subject } from '../core/models';

@Injectable({ providedIn: 'root' })
export class TeacherApi {
  private readonly http = inject(HttpClient);
  readonly sections = signal<Section[]>([]);
  readonly subjects = signal<Subject[]>([]);
  private metaLoaded: Promise<void> | null = null;

  loadMeta(): Promise<void> {
    this.metaLoaded ??= firstValueFrom(this.http.get<{ sections: Section[]; subjects: Subject[] }>('/api/teacher/meta')).then((m) => {
      this.sections.set(m.sections);
      this.subjects.set(m.subjects);
    });
    return this.metaLoaded;
  }

  get<T>(url: string, params?: Record<string, string | number | undefined | null>) {
    return firstValueFrom(this.http.get<T>(url, { params: clean(params) }));
  }
  post<T>(url: string, body: unknown) {
    return firstValueFrom(this.http.post<T>(url, body));
  }
  put<T>(url: string, body: unknown) {
    return firstValueFrom(this.http.put<T>(url, body));
  }
  patch<T>(url: string, body: unknown) {
    return firstValueFrom(this.http.patch<T>(url, body));
  }
  delete<T>(url: string) {
    return firstValueFrom(this.http.delete<T>(url));
  }

  async download(url: string, params: Record<string, string | number | undefined | null>, fallbackName: string) {
    const res = await firstValueFrom(this.http.get(url, { params: clean(params), responseType: 'blob', observe: 'response' }));
    const disposition = res.headers.get('Content-Disposition') ?? '';
    const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackName;
    const href = URL.createObjectURL(res.body!);
    const a = document.createElement('a');
    a.href = href;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }
}

function clean(params?: Record<string, string | number | undefined | null>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== null && v !== '') out[k] = String(v);
  return out;
}

/** File contents as base64 (no "data:" prefix), for uploading .xlsx in a JSON body. */
export function readFileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? '').replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}
