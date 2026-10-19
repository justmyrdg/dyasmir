import { Routes } from '@angular/router';
import { guestOnly, homeRedirect, passwordChosen, roleGuard } from './core/guards';
import { Shell } from './shared/shell';

const quizzesCrumb = { parent: { label: 'Quizzes', link: '/teacher/quizzes' } };
const resultsCrumb = { parent: { label: 'Results', link: '/teacher/results' } };

export const routes: Routes = [
  { path: 'login', title: 'Sign in', canActivate: [guestOnly], loadComponent: () => import('./pages/login').then((m) => m.LoginPage) },
  {
    path: 'student',
    component: Shell,
    canActivate: [roleGuard('student')],
    canActivateChild: [passwordChosen],
    children: [
      { path: '', title: 'My quizzes', loadComponent: () => import('./student/student-dashboard').then((m) => m.StudentDashboard) },
      { path: 'password', title: 'Change password', loadComponent: () => import('./student/change-password').then((m) => m.ChangePassword) },
      { path: 'attempts/:id', title: 'Quiz', loadComponent: () => import('./student/quiz-take').then((m) => m.QuizTake) },
      { path: 'attempts/:id/result', title: 'Result', loadComponent: () => import('./student/quiz-result').then((m) => m.QuizResult) },
    ],
  },
  {
    path: 'teacher',
    component: Shell,
    canActivate: [roleGuard('teacher')],
    children: [
      { path: '', title: 'Dashboard', loadComponent: () => import('./teacher/teacher-dashboard').then((m) => m.TeacherDashboard) },
      { path: 'students', title: 'Students', loadComponent: () => import('./teacher/students').then((m) => m.StudentsPage) },
      { path: 'online', title: 'Online now', loadComponent: () => import('./teacher/online').then((m) => m.OnlinePage) },
      { path: 'quizzes', title: 'Quizzes', loadComponent: () => import('./teacher/quizzes').then((m) => m.QuizzesPage) },
      { path: 'quizzes/new', title: 'New quiz', data: quizzesCrumb, loadComponent: () => import('./teacher/quiz-editor').then((m) => m.QuizEditor) },
      { path: 'quizzes/:id', title: 'Edit quiz', data: quizzesCrumb, loadComponent: () => import('./teacher/quiz-editor').then((m) => m.QuizEditor) },
      {
        path: 'quizzes/:id/assign',
        title: 'Assign to sections',
        data: quizzesCrumb,
        loadComponent: () => import('./teacher/quiz-assign').then((m) => m.QuizAssign),
      },
      { path: 'results', title: 'Results', loadComponent: () => import('./teacher/results').then((m) => m.ResultsPage) },
      {
        path: 'attempts/:id',
        title: 'Review attempt',
        data: resultsCrumb,
        loadComponent: () => import('./teacher/attempt-detail').then((m) => m.AttemptDetailPage),
      },
    ],
  },
  { path: '', pathMatch: 'full', canActivate: [homeRedirect], children: [] },
  { path: '**', redirectTo: '' },
];
