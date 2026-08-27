import { computed, ref } from 'vue'

type SpeechRecognitionCtor = new () => { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void; onresult: ((event: any) => void) | null; onerror: (() => void) | null; onend: (() => void) | null }
export function useSpeech(onText: (text: string) => void) {
  const ctor = (window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: SpeechRecognitionCtor }).webkitSpeechRecognition
  const supported = Boolean(ctor)
  const listening = ref(false)
  let recognition: InstanceType<SpeechRecognitionCtor> | undefined
  function toggle() {
    if (!ctor) return
    if (listening.value) { recognition?.stop(); return }
    recognition = new ctor(); recognition.lang = navigator.language || 'zh-CN'; recognition.continuous = true; recognition.interimResults = false
    recognition.onresult = event => { let text = ''; for (let index = event.resultIndex; index < event.results.length; index++) text += event.results[index][0].transcript; onText(text) }
    recognition.onerror = () => { listening.value = false }
    recognition.onend = () => { listening.value = false }
    listening.value = true; recognition.start()
  }
  return { supported, listening: computed(() => listening.value), toggle }
}
