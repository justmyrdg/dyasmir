import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { errorDetails, errorMessage } from '../core/errors';
import type { Student, Subject } from '../core/models';
import { SR_CODE_REGEX } from '../core/sr-code';
import { formatManila } from '../core/time';
import { readFileBase64, readFileText, TeacherApi } from './teacher-api';

interface ImportError {
  line: number;
  srCode?: string;
  error: string;
}

/** "Embedded Systems (CpET343)" -> "CpET343"; other names unchanged. */
export function shortSubject(name: string): string {
  return /\(([^)]+)\)/.exec(name)?.[1] ?? name;
}

@Component({
  selector: 'app-students',
  imports: [FormsModule],
  template: `
    <div class="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold">Students</h1>
        <p class="max-w-3xl text-sm text-slate-500">
          One account per student (their SR code), used for every subject. For each subject choose the section the student takes it in;
          irregular students can take each subject in a different section.
        </p>
      </div>
      <div class="flex gap-2">
        <button class="btn-secondary" (click)="panel.set(panel() === 'import' ? null : 'import')">Import from Excel</button>
        <button class="btn-primary" (click)="openAdd()">Add student</button>
      </div>
    </div>

    @if (message()) {
      <div class="alert-success mb-4">{{ message() }}</div>
    }
    @if (error()) {
      <div class="alert-error mb-4">
        {{ error() }}
        @if (importErrors().length) {
          <ul class="mt-2 list-disc pl-5">
            @for (e of importErrors(); track e.line) {
              <li>Row {{ e.line }}{{ e.srCode ? ' (' + e.srCode + ')' : '' }}: {{ e.error }}</li>
            }
          </ul>
        }
      </div>
    }

    @if (panel() === 'add') {
      <form class="card mb-6 grid gap-4 p-5 md:grid-cols-6" (ngSubmit)="add()">
        <div>
          <label class="label" for="nsr">SR code</label>
          <input id="nsr" class="input" name="sr" placeholder="23-12345" maxlength="8" [(ngModel)]="form.srCode" />
          @if (form.srCode && !srOk(form.srCode)) {
            <p class="mt-1 text-xs text-rose-600">Format NN-NNNNN</p>
          }
        </div>
        <div class="md:col-span-2">
          <label class="label" for="nname">Full name</label>
          <input id="nname" class="input" name="name" placeholder="Dela Cruz, Juan" [(ngModel)]="form.name" />
        </div>
        <div>
          <label class="label" for="nsec">Own section</label>
          <select id="nsec" class="input" name="sec" [ngModel]="form.sectionId" (ngModelChange)="setFormSection($event)">
            @for (s of api.sections(); track s.id) {
              <option [ngValue]="s.id">{{ s.name }}</option>
            }
          </select>
        </div>
        <div class="md:col-span-2">
          <label class="label" for="npw">Initial password</label>
          <input id="npw" class="input" name="pw" type="text" placeholder="min 6 characters" [(ngModel)]="form.password" />
        </div>
        <fieldset class="md:col-span-6">
          <legend class="label">Subjects and the section each is taken in</legend>
          <div class="grid gap-3 sm:grid-cols-2">
            @for (sub of api.subjects(); track sub.id) {
              <label class="flex items-center gap-3 rounded-xl border-2 border-slate-200 px-3 py-2 text-sm">
                <span class="flex-1 font-semibold">{{ sub.name }}</span>
                <select class="input w-40" [name]="'enroll' + sub.id" [ngModel]="form.enroll[sub.id] ?? null" (ngModelChange)="form.enroll[sub.id] = $event">
                  <option [ngValue]="null">Not taken</option>
                  @for (s of api.sections(); track s.id) {
                    <option [ngValue]="s.id">{{ s.name }}</option>
                  }
                </select>
              </label>
            }
          </div>
        </fieldset>
        <div class="flex justify-end gap-2 md:col-span-6">
          <button type="button" class="btn-ghost" (click)="panel.set(null)">Cancel</button>
          <button type="submit" class="btn-primary" [disabled]="busy() || !srOk(form.srCode) || !form.name.trim() || form.password.length < 6 || !form.sectionId">
            Save student
          </button>
        </div>
      </form>
    }

    @if (panel() === 'import') {
      <div class="card mb-6 p-5">
        <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 class="text-lg font-bold">Import students</h2>
            <p class="text-sm text-slate-500">Download the Excel template, fill in one row per student, then upload it here.</p>
          </div>
          <button type="button" class="btn-secondary" [disabled]="busy()" (click)="downloadTemplate()">Download Excel template</button>
        </div>
        <ol class="mb-4 list-decimal space-y-1 pl-5 text-sm text-slate-600">
          <li><strong>SR code</strong> (NN-NNNNN), <strong>Name</strong> and the first <strong>Password</strong> (6 or more characters).</li>
          <li>
            Under each subject, pick the <strong>section</strong> the student takes it in from the dropdown. Leave it blank if they don't take that subject.
          </li>
          <li>Irregular student? Pick a different section per subject in the same row. They still use one account.</li>
          <li>Save the file and upload it below. A CSV with the same columns works too.</li>
        </ol>
        <div class="flex flex-wrap items-center gap-3">
          <label class="btn-primary" [class.opacity-50]="busy()">
            {{ busy() ? 'Importing…' : 'Upload filled template' }}
            <input type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" class="hidden" (change)="importFile($event)" [disabled]="busy()" />
          </label>
          <span class="text-xs text-slate-500">If any row has a problem nothing is imported and every problem row is listed. SR codes that already exist are skipped.</span>
        </div>
      </div>
    }

    <div class="card overflow-hidden">
      <div class="border-b border-slate-200 px-4 pt-4 pb-3">
        <h2 class="mb-3 text-lg font-bold">Students <span class="font-normal text-slate-500">({{ visible().length }})</span></h2>
        <div class="flex flex-wrap gap-2">
          <select class="input w-auto" [ngModel]="sectionFilter()" (ngModelChange)="sectionFilter.set($event); load()">
            <option [ngValue]="null">All sections</option>
            @for (s of api.sections(); track s.id) {
              <option [ngValue]="s.id">{{ s.name }}</option>
            }
          </select>
          <select class="input w-auto" [ngModel]="subjectFilter()" (ngModelChange)="subjectFilter.set($event); load()">
            <option [ngValue]="null">All subjects</option>
            @for (s of api.subjects(); track s.id) {
              <option [ngValue]="s.id">{{ s.name }}</option>
            }
          </select>
          <input class="input w-64" placeholder="Search name or SR code" [ngModel]="search()" (ngModelChange)="search.set($event)" />
          <label class="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" [ngModel]="showInactive()" (ngModelChange)="showInactive.set($event)" /> Show deactivated
          </label>
        </div>
      </div>

      <div class="overflow-x-auto">
        <table class="table">
          <thead>
            <tr>
              <th>SR code</th>
              <th>Name</th>
              <th>Own section</th>
              <th>Subjects (section taken in)</th>
              <th>Status</th>
              <th class="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            @for (s of visible(); track s.id) {
              <tr [class.opacity-60]="!s.isActive">
                <td class="font-mono whitespace-nowrap">{{ s.srCode }}</td>
                <td>
                  {{ s.name }}
                  @if (isIrregular(s)) {
                    <span class="badge ml-1 bg-amber-100 text-amber-800" title="Takes a subject in a section other than their own">Irregular</span>
                  }
                  <div class="text-xs text-slate-400">Added {{ fmt(s.createdAt) }}</div>
                </td>
                <td class="whitespace-nowrap">{{ s.section }}</td>
                <td>
                  <div class="space-y-1">
                    @for (sub of api.subjects(); track sub.id) {
                      <label class="flex items-center gap-2 text-xs">
                        <span class="w-28 shrink-0 font-semibold text-slate-600" [title]="sub.name">{{ short(sub.name) }}</span>
                        <select
                          class="rounded-md border-2 bg-white px-2 py-0.5 text-xs font-medium focus:border-indigo-500 focus:outline-none"
                          [class]="sectionOf(s, sub) === null ? 'border-slate-200 text-slate-400' : sectionOf(s, sub) !== s.sectionId ? 'border-amber-400 text-amber-800' : 'border-slate-300 text-ink'"
                          [disabled]="savingId() === s.id"
                          [attr.aria-label]="sub.name + ' section for ' + s.name"
                          (change)="setEnrollment(s, sub, $any($event.target).value)"
                        >
                          <option value="" [selected]="sectionOf(s, sub) === null">Not taken</option>
                          @for (sec of api.sections(); track sec.id) {
                            <option [value]="sec.id" [selected]="sectionOf(s, sub) === sec.id">{{ sec.name }}</option>
                          }
                        </select>
                      </label>
                    }
                  </div>
                </td>
                <td>
                  @if (s.isActive) {
                    <span class="badge bg-emerald-100 text-emerald-800">Active</span>
                  } @else {
                    <span class="badge bg-slate-200 text-slate-700">Deactivated</span>
                  }
                </td>
                <td class="text-right whitespace-nowrap">
                  <button class="btn-ghost btn-sm" (click)="resetPassword(s)">Reset password</button>
                  @if (s.isActive) {
                    <button class="btn-ghost btn-sm text-rose-600" (click)="setActive(s, false)">Deactivate</button>
                  } @else {
                    <button class="btn-ghost btn-sm" (click)="setActive(s, true)">Reactivate</button>
                  }
                </td>
              </tr>
            } @empty {
              <tr>
                <td colspan="6" class="py-8 text-center text-slate-500">{{ loading() ? 'Loading…' : 'No students found.' }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </div>
  `,
})
export class StudentsPage implements OnInit {
  protected readonly api = inject(TeacherApi);
  protected readonly students = signal<Student[]>([]);
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly savingId = signal<number | null>(null);
  protected readonly error = signal('');
  protected readonly message = signal('');
  protected readonly importErrors = signal<ImportError[]>([]);
  protected readonly panel = signal<'add' | 'import' | null>(null);
  protected readonly sectionFilter = signal<number | null>(null);
  protected readonly subjectFilter = signal<number | null>(null);
  protected readonly search = signal('');
  protected readonly showInactive = signal(false);
  protected readonly fmt = formatManila;
  protected readonly short = shortSubject;
  protected form = {
    srCode: '',
    name: '',
    sectionId: null as number | null,
    password: '',
    /** subjectId -> section it is taken in (null = not taken) */
    enroll: {} as Record<number, number | null>,
  };

  protected readonly visible = computed(() => {
    const q = this.search().trim().toLowerCase();
    return this.students().filter(
      (s) => (this.showInactive() || s.isActive) && (!q || s.name.toLowerCase().includes(q) || s.srCode.includes(q)),
    );
  });

  async ngOnInit() {
    await this.api.loadMeta();
    this.resetForm();
    await this.load();
  }

  protected srOk(v: string) {
    return SR_CODE_REGEX.test(v.trim());
  }

  protected sectionOf(s: Student, sub: Subject): number | null {
    return s.subjects.find((x) => x.id === sub.id)?.sectionId ?? null;
  }

  protected isIrregular(s: Student) {
    return s.subjects.some((x) => x.sectionId !== s.sectionId);
  }

  private resetForm() {
    const sectionId = this.form.sectionId ?? this.api.sections()[0]?.id ?? null;
    const enroll: Record<number, number | null> = {};
    for (const sub of this.api.subjects()) enroll[sub.id] = sectionId;
    this.form = { srCode: '', name: '', password: '', sectionId, enroll };
  }

  protected openAdd() {
    if (this.panel() !== 'add') this.resetForm();
    this.panel.set(this.panel() === 'add' ? null : 'add');
  }

  /** Changing the own section moves the subjects that followed it. */
  protected setFormSection(sectionId: number) {
    const previous = this.form.sectionId;
    for (const sub of this.api.subjects()) if (this.form.enroll[sub.id] === previous) this.form.enroll[sub.id] = sectionId;
    this.form.sectionId = sectionId;
  }

  protected async load() {
    this.loading.set(true);
    try {
      this.students.set(
        await this.api.get<Student[]>('/api/teacher/students', { sectionId: this.sectionFilter(), subjectId: this.subjectFilter() }),
      );
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.loading.set(false);
    }
  }

  private reset() {
    this.error.set('');
    this.message.set('');
    this.importErrors.set([]);
  }

  protected async add() {
    this.reset();
    this.busy.set(true);
    try {
      const enrollments = Object.entries(this.form.enroll)
        .filter(([, sectionId]) => sectionId !== null)
        .map(([subjectId, sectionId]) => ({ subjectId: Number(subjectId), sectionId: sectionId! }));
      const s = await this.api.post<Student>('/api/teacher/students', {
        srCode: this.form.srCode.trim(),
        name: this.form.name.trim(),
        sectionId: this.form.sectionId,
        password: this.form.password,
        enrollments,
      });
      const subjects = s.subjects.length ? s.subjects.map((x) => `${x.name} (${x.section})`).join(' and ') : 'no subjects yet';
      this.message.set(`Added ${s.name} (${s.srCode}), taking ${subjects}.`);
      this.resetForm();
      await this.load();
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }

  protected async setEnrollment(s: Student, sub: Subject, value: string) {
    const sectionId = value ? Number(value) : null;
    const before = this.sectionOf(s, sub);
    if (sectionId === before) return;
    if (sectionId === null && !confirm(`Remove ${s.name} from ${sub.name}? They will no longer see its quizzes (results already taken are kept).`)) {
      this.students.update((list) => [...list]); // re-render to restore the dropdown
      return;
    }
    const enrollments = [
      ...s.subjects.filter((x) => x.id !== sub.id).map((x) => ({ subjectId: x.id, sectionId: x.sectionId })),
      ...(sectionId !== null ? [{ subjectId: sub.id, sectionId }] : []),
    ];
    this.reset();
    this.savingId.set(s.id);
    try {
      const updated = await this.api.patch<Student>(`/api/teacher/students/${s.id}`, { enrollments });
      this.students.update((list) => list.map((x) => (x.id === s.id ? updated : x)));
      const where = updated.subjects.find((x) => x.id === sub.id)?.section;
      this.message.set(where ? `${s.name} now takes ${sub.name} with ${where}.` : `${s.name} removed from ${sub.name}.`);
    } catch (err) {
      this.error.set(errorMessage(err));
      this.students.update((list) => [...list]);
    } finally {
      this.savingId.set(null);
    }
  }

  protected async downloadTemplate() {
    try {
      await this.api.download('/api/teacher/students/template', {}, 'JASthinkAboutIT-students-template.xlsx');
    } catch (err) {
      this.error.set(errorMessage(err, 'Could not download the template.'));
    }
  }

  protected async importFile(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.reset();
    this.busy.set(true);
    try {
      const isExcel = /\.xlsx$/i.test(file.name);
      if (!isExcel && !/\.csv$/i.test(file.name)) throw new Error('Choose the .xlsx template (or a .csv file).');
      const body = isExcel ? { xlsxBase64: await readFileBase64(file) } : { csv: await readFileText(file) };
      const res = await this.api.post<{ created: number; skipped: string[] }>('/api/teacher/students/import', body);
      this.message.set(
        `Imported ${res.created} student(s).` + (res.skipped.length ? ` Skipped ${res.skipped.length} existing SR code(s): ${res.skipped.join(', ')}.` : ''),
      );
      this.panel.set(null);
      await this.load();
    } catch (err) {
      this.error.set(err instanceof Error && !('status' in err) ? err.message : errorMessage(err));
      const details = errorDetails<ImportError[]>(err);
      if (Array.isArray(details) && details.every((d) => typeof d === 'object')) this.importErrors.set(details);
    } finally {
      this.busy.set(false);
      input.value = '';
    }
  }

  protected async resetPassword(s: Student) {
    const pw = prompt(`New password for ${s.name} (${s.srCode}), at least 6 characters:`);
    if (pw === null) return;
    if (pw.length < 6) {
      this.error.set('Password must be at least 6 characters.');
      return;
    }
    this.reset();
    try {
      await this.api.post(`/api/teacher/students/${s.id}/reset-password`, { password: pw });
      this.message.set(`Password reset for ${s.name}. Any open sessions were signed out.`);
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }

  protected async setActive(s: Student, isActive: boolean) {
    if (!isActive && !confirm(`Deactivate ${s.name}? They will be signed out and cannot log in.`)) return;
    this.reset();
    try {
      await this.api.patch(`/api/teacher/students/${s.id}`, { isActive });
      this.message.set(`${s.name} ${isActive ? 'reactivated' : 'deactivated'}.`);
      await this.load();
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }
}
