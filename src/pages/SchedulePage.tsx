import { useParams } from 'react-router-dom'
import { PageHeader } from '../components/ui.tsx'

export function SchedulePage() {
  const { id } = useParams()
  return (
    <div>
      <PageHeader title={`Schedule for session ${id}`} />
      <p className="text-sm text-slate-500">The schedule grid is coming next.</p>
    </div>
  )
}
