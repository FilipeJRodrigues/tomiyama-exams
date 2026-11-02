import { Navigate, type RouteObject } from 'react-router';

import { ExamDayPage } from '../features/exam-day/ExamDayPage';
import { LoginPage } from '../features/auth/LoginPage';
import { SignUpPage } from '../features/auth/SignUpPage';
import { NotFoundPage, PlaceholderPage } from '../features/placeholder/PlaceholderPage';
import { StudentCreatePage } from '../features/students/StudentCreatePage';
import { StudentEditPage } from '../features/students/StudentEditPage';
import { StudentsPage } from '../features/students/StudentsPage';
import { AppLayout } from './AppLayout';
import { RequireAuth, RequireExaminer } from './guards';
import { paths } from './navigation';

export interface RoutesOptions {
  useMocks: boolean;
}

export function createRoutes({ useMocks }: RoutesOptions): RouteObject[] {
  return [
    { path: paths.login, element: <LoginPage /> },
    { path: paths.signUp, element: <SignUpPage /> },
    {
      element: <RequireAuth />,
      children: [
        {
          element: <AppLayout useMocks={useMocks} />,
          children: [
            { index: true, element: <Navigate to={paths.students} replace /> },
            { path: paths.students, element: <StudentsPage /> },
            { path: paths.studentNew, element: <StudentCreatePage /> },
            { path: paths.studentEdit, element: <StudentEditPage /> },
            {
              element: <RequireExaminer />,
              children: [
                { path: paths.examDay, element: <ExamDayPage /> },
                { path: paths.exam, element: <PlaceholderPage title="Exame do aluno" /> },
                { path: paths.belts, element: <PlaceholderPage title="Faixas" /> },
                { path: paths.requirements, element: <PlaceholderPage title="Requisitos" /> },
                { path: paths.events, element: <PlaceholderPage title="Eventos" /> },
                { path: paths.academy, element: <PlaceholderPage title="Academia" /> },
              ],
            },
            { path: '*', element: <NotFoundPage /> },
          ],
        },
      ],
    },
  ];
}
