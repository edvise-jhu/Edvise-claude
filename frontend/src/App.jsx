import { Routes, Route, Navigate } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { supabase } from './lib/supabase'
import Login from './pages/Login'
import MainApp from './pages/App'
import Library from './pages/Library'

export default function App() {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const supabaseConfigured = import.meta.env.VITE_SUPABASE_URL?.startsWith('https://')

    function readDemoSession() {
      const raw = localStorage.getItem('edvise_demo_session')
      if (!raw) return null
      try {
        return JSON.parse(raw)
      } catch {
        return null
      }
    }

    if (!supabaseConfigured) {
      setSession(readDemoSession())
      setLoading(false)
      return
    }

    // With Supabase: still honor local demo session (admin bypass) when present
    const demoSession = readDemoSession()

    supabase.auth
      .getSession()
      .then(({ data: { session } }) => {
        if (session) {
          localStorage.removeItem('edvise_demo_session')
          setSession(session)
        } else if (demoSession) {
          setSession(demoSession)
        } else {
          setSession(null)
        }
        setLoading(false)
      })
      .catch(() => {
        if (demoSession) setSession(demoSession)
        setLoading(false)
      })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) {
        localStorage.removeItem('edvise_demo_session')
        setSession(session)
      } else if (!localStorage.getItem('edvise_demo_session')) {
        setSession(null)
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => {
    const token = session?.access_token
    if (token) {
      localStorage.setItem('edvise_token', token)
    } else {
      localStorage.removeItem('edvise_token')
    }
  }, [session?.access_token])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-bg">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-3 border-primary border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-gray-500">Loading EdVise...</span>
        </div>
      </div>
    )
  }

  return (
    <Routes>
      <Route path="/login" element={!session ? <Login /> : <Navigate to="/" replace />} />
      <Route path="/library" element={session ? <Library session={session} /> : <Navigate to="/login" replace />} />
      <Route path="/*" element={session ? <MainApp session={session} /> : <Navigate to="/login" replace />} />
    </Routes>
  )
}
