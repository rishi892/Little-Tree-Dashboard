import { useMemo } from 'react'

export default function Embers({ count = 18 }) {
  const embers = useMemo(() => {
    return Array.from({ length: count }, (_, i) => ({
      id: i,
      x: Math.random() * 100,
      size: Math.random() * 3 + 1.5,
      delay: Math.random() * 12,
      duration: Math.random() * 14 + 12,
      drift: (Math.random() - 0.5) * 40,
    }))
  }, [count])

  return (
    <div className="embers" aria-hidden="true">
      {embers.map((e) => (
        <span
          key={e.id}
          className="ember"
          style={{
            left: `${e.x}%`,
            width: `${e.size}px`,
            height: `${e.size}px`,
            animationDelay: `${e.delay}s`,
            animationDuration: `${e.duration}s`,
            '--drift': `${e.drift}px`,
          }}
        />
      ))}
    </div>
  )
}
