import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './auth/AuthContext.tsx'
import { LoginPage } from './auth/LoginPage.tsx'
import { SetupPage } from './auth/SetupPage.tsx'
import { Layout } from './components/Layout.tsx'
import { Dashboard } from './pages/Dashboard.tsx'
import { EventsPage } from './pages/EventsPage.tsx'
import { CoachesPage } from './pages/CoachesPage.tsx'
import { GroupsPage } from './pages/GroupsPage.tsx'
import { SessionsPage } from './pages/SessionsPage.tsx'
import { SchedulePage } from './pages/SchedulePage.tsx'
import { SetupWizard } from './pages/SetupWizard.tsx'
import { PrintPage } from './pages/PrintPage.tsx'

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
            <Route path="/groups" element={<GroupsPage />} />
            <Route path="/sessions" element={<SessionsPage />} />
            <Route path="/sessions/:id/schedule" element={<SchedulePage />} />
            <Route path="/sessions/:id/print" element={<PrintPage />} />
            <Route path="/guide/:step?" element={<SetupWizard />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}

export default App
