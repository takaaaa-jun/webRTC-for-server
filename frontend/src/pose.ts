export type PoseLandmark = {
  x: number
  y: number
  z: number
  visibility?: number
  presence?: number
}

export type PoseFrame = {
  room_id: string
  updated_at: number
  image_width: number
  image_height: number
  landmarks: PoseLandmark[]
}

export type PoseDisplayMode = 'video' | 'skeleton' | 'both'

export const POSE_CONNECTIONS: Array<[number, number]> = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 7],
  [0, 4],
  [4, 5],
  [5, 6],
  [6, 8],
  [9, 10],
  [11, 12],
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
  [11, 23],
  [12, 24],
  [23, 24],
  [23, 25],
  [24, 26],
  [25, 27],
  [26, 28],
  [27, 29],
  [28, 30],
  [29, 31],
  [30, 32],
]

export const KEY_LANDMARKS: Array<{ index: number; label: string }> = [
  { index: 0, label: 'nose' },
  { index: 11, label: 'left_shoulder' },
  { index: 12, label: 'right_shoulder' },
  { index: 13, label: 'left_elbow' },
  { index: 14, label: 'right_elbow' },
  { index: 15, label: 'left_wrist' },
  { index: 16, label: 'right_wrist' },
  { index: 23, label: 'left_hip' },
  { index: 24, label: 'right_hip' },
  { index: 25, label: 'left_knee' },
  { index: 26, label: 'right_knee' },
  { index: 27, label: 'left_ankle' },
  { index: 28, label: 'right_ankle' },
]

export type PoseSummaryRow = {
  label: string
  index: number
  x: number
  y: number
  visibility: number | null
}

export function normalizeLandmarks(input: Array<Record<string, unknown>> | undefined): PoseLandmark[] {
  if (!Array.isArray(input)) {
    return []
  }

  return input.map((item) => ({
    x: Number(item.x ?? 0),
    y: Number(item.y ?? 0),
    z: Number(item.z ?? 0),
    visibility: typeof item.visibility === 'number' ? item.visibility : undefined,
    presence: typeof item.presence === 'number' ? item.presence : undefined,
  }))
}

export function buildPoseSummary(frame: PoseFrame | null | undefined): PoseSummaryRow[] {
  if (!frame?.landmarks?.length) {
    return []
  }

  return KEY_LANDMARKS.map(({ index, label }) => {
    const landmark = frame.landmarks[index]
    if (!landmark) {
      return {
        label,
        index,
        x: 0,
        y: 0,
        visibility: null,
      }
    }

    return {
      label,
      index,
      x: landmark.x,
      y: landmark.y,
      visibility: typeof landmark.visibility === 'number' ? landmark.visibility : null,
    }
  })
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value))
}

export function drawPoseFrame(
  canvas: HTMLCanvasElement,
  frame: PoseFrame | null | undefined,
  options?: {
    showLabels?: boolean
    background?: string
    accentColor?: string
    pointColor?: string
    lineColor?: string
    emptyText?: string
  },
) {
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return
  }

  const width = Math.max(1, frame?.image_width || canvas.clientWidth || canvas.width || 1280)
  const height = Math.max(1, frame?.image_height || canvas.clientHeight || canvas.height || 720)

  if (canvas.width !== width) {
    canvas.width = width
  }
  if (canvas.height !== height) {
    canvas.height = height
  }

  ctx.clearRect(0, 0, width, height)
  if (options?.background) {
    ctx.fillStyle = options.background
    ctx.fillRect(0, 0, width, height)
  }

  const landmarks = frame?.landmarks ?? []
  if (!landmarks.length) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.78)'
    ctx.font = '600 20px Inter, system-ui, sans-serif'
    ctx.fillText(options?.emptyText ?? '骨格データを待機中', 24, 36)
    return
  }

  const strokeStyle = options?.lineColor ?? 'rgba(120, 166, 255, 0.9)'
  const pointStyle = options?.pointColor ?? 'rgba(232, 238, 246, 1)'
  const accentStyle = options?.accentColor ?? 'rgba(97, 218, 251, 1)'
  const lineWidth = Math.max(2, Math.round(Math.min(width, height) * 0.005))
  const pointRadius = Math.max(3, Math.round(lineWidth * 1.15))

  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  ctx.strokeStyle = strokeStyle
  ctx.lineWidth = lineWidth
  for (const [startIndex, endIndex] of POSE_CONNECTIONS) {
    const start = landmarks[startIndex]
    const end = landmarks[endIndex]
    if (!start || !end) {
      continue
    }
    if (start.visibility !== undefined && start.visibility < 0.25) {
      continue
    }
    if (end.visibility !== undefined && end.visibility < 0.25) {
      continue
    }

    ctx.beginPath()
    ctx.moveTo(clamp01(start.x) * width, clamp01(start.y) * height)
    ctx.lineTo(clamp01(end.x) * width, clamp01(end.y) * height)
    ctx.stroke()
  }

  for (let index = 0; index < landmarks.length; index += 1) {
    const landmark = landmarks[index]
    if (!landmark) {
      continue
    }
    if (landmark.visibility !== undefined && landmark.visibility < 0.2) {
      continue
    }

    const x = clamp01(landmark.x) * width
    const y = clamp01(landmark.y) * height

    ctx.beginPath()
    ctx.fillStyle = pointStyle
    ctx.arc(x, y, pointRadius, 0, Math.PI * 2)
    ctx.fill()

    ctx.beginPath()
    ctx.fillStyle = accentStyle
    ctx.arc(x, y, Math.max(1.5, pointRadius * 0.5), 0, Math.PI * 2)
    ctx.fill()
  }

  if (options?.showLabels) {
    ctx.font = '600 14px Inter, system-ui, sans-serif'
    ctx.fillStyle = 'rgba(255, 255, 255, 0.88)'
    for (const { index, label } of KEY_LANDMARKS) {
      const landmark = landmarks[index]
      if (!landmark) {
        continue
      }
      const x = clamp01(landmark.x) * width
      const y = clamp01(landmark.y) * height
      ctx.fillText(label, x + 8, y - 8)
    }
  }
}
