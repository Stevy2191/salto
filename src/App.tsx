import { BrowserRouter, Route, Routes, useParams } from 'react-router-dom'
import { AuthProvider } from './auth/AuthContext.tsx'
import { LoginPage } from './auth/LoginPage.tsx'
import { SetupPage } from './auth/SetupPage.tsx'
import { Layout } from './components/Layout.tsx'
import { Dashboard } from './pages/Dashboard.tsx'
import { EventsPage } from './pages/EventsPage.tsx'
import { CoachesPage } from './pages/CoachesPage.tsx'
import { ClassesPage } from './pages/ClassesPage.tsx'
import { SessionsPage } from './pages/SessionsPage.tsx'
import { SchedulePage } from './pages/SchedulePage.tsx'
import { PrintPage } from './pages/PrintPage.tsx'

// Remount the schedule editor when the session id changes (e.g. after
// "Copy session" navigates to the copy) so all loaders refetch.
function KeyedSchedulePage() {
  const { id } = useParams()
  return <SchedulePage key={id} />
}

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/setup" element={<SetupPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route element={<Layout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/events" element={<EventsPage />} />
            <Route path="/coaches" element={<CoachesPage />} />
            <Route path="/classes" element={<ClassesPage />} />
            <Route path="/sessions" element={<SessionsPage />} />
            <Route path="/sessions/:id/schedule" element={<KeyedSchedulePage />} />
            <Route path="/sessions/:id/print" element={<PrintPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}

export default App
