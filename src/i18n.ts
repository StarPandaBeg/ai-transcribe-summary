import { getLanguage } from "obsidian";

const RU: Record<string, string> = {
	"AI tasks": "Задачи ИИ",
	"Open AI tasks": "Открыть задачи ИИ",
	"Open task center": "Открыть центр задач",
	"Current tasks": "Текущие задачи",
	"Active tasks: {count}": "Активных задач: {count}",
	"No tasks are running": "Нет выполняющихся задач",
	"Recording, transcription, and summary progress will appear here.": "Здесь будет отображаться прогресс записи, транскрипции и создания конспекта.",
	"Elapsed {duration}": "Прошло {duration}",
	"Stop task": "Остановить задачу",
	"Stop recording": "Остановить запись",
	"Stop recording?": "Остановить запись?",
	"This will end the current recording. This can't be undone.": "Текущая запись будет завершена. Это действие нельзя отменить.",
	Cancel: "Отмена",
	"Start recording": "Начать запись",
	"Start recording?": "Начать запись?",
	"This will start recording audio from your microphone.": "Начнётся запись звука с микрофона.",
	"Recording could not be checked": "Не удалось проверить запись",
	"This audio could not be read - it may be empty or corrupted. Sending it for transcription is likely to fail.":
		"Не удалось прочитать аудио: возможно, файл пуст или повреждён. Скорее всего, отправка на транскрипцию завершится ошибкой.",
	"Recording appears to be silent": "Похоже, запись не содержит звука",
	"No audio signal was detected in this recording. You can still transcribe and summarize it, but the result may be empty.":
		"В записи не обнаружен аудиосигнал. Её всё равно можно транскрибировать и законспектировать, но результат может оказаться пустым.",
	Discard: "Удалить",
	"Transcribe anyway": "Всё равно транскрибировать",
	"Start meeting recording": "Начать запись встречи",
	"Stop meeting recording": "Остановить запись встречи",
	"Start/Stop recording": "Начать/остановить запись",
	"Pause/resume recording": "Приостановить/продолжить запись",
	"Transcribe & summarize active file": "Транскрибировать и законспектировать активный файл",
	"Stop transcription/summary": "Остановить транскрипцию/конспект",
	"Summarize note": "Создать конспект заметки",
	"Transcribe & summarize": "Транскрибировать и законспектировать",
	"Could not open \"{name}\" for editing.": "Не удалось открыть «{name}» для редактирования.",
	"Summarize “{name}”": "Конспект «{name}»",
	"Process “{name}”": "Обработка «{name}»",
	Starting: "Запуск",
	Stopping: "Остановка",
	"Stopping...": "Остановка…",
	"Meeting recording": "Запись встречи",
	Recording: "Запись",
	Paused: "Пауза",
	"Finishing recording": "Завершение записи",
	"Saving audio": "Сохранение аудио",
	"Could not start recording - check microphone permissions.": "Не удалось начать запись — проверьте разрешение на доступ к микрофону.",
	"No microphone input detected. Check your mic - this recording may come out empty.":
		"Сигнал с микрофона не обнаружен. Проверьте микрофон — запись может оказаться пустой.",
	"Recording stop failed - no audio was saved.": "Не удалось остановить запись — аудио не сохранено.",
	"Recording was too short to transcribe - nothing was saved.": "Запись слишком короткая для транскрипции — ничего не сохранено.",
	"Audio folder \"{path}\" is not a folder - recording not saved.": "Путь папки аудио «{path}» не является папкой — запись не сохранена.",
	"Failed to create audio folder - recording not saved. See console for details.":
		"Не удалось создать папку аудио — запись не сохранена. Подробности смотрите в консоли.",
	"Recording saved to {path}": "Запись сохранена: {path}",
	"Failed to save recording audio file - see console for details.": "Не удалось сохранить аудиозапись — подробности смотрите в консоли.",
	"{minutes} minutes of silence": "{minutes} мин. тишины",
	"the {hours}-hour maximum recording duration": "максимальная длительность записи ({hours} ч.)",
	"Recording auto-stopped: reached {reason}.": "Запись автоматически остановлена: достигнуто ограничение — {reason}.",
	"This recording is over {hours} hours long. If it needs to be split for transcription, decoding it may use a lot of memory and could fail on this device.":
		"Эта запись длится более {hours} ч. Если её потребуется разделить для транскрипции, декодирование может занять много памяти и завершиться ошибкой на этом устройстве.",
	" The audio file is already saved, so it's safe either way.": " Аудиофайл уже сохранён, поэтому запись не потеряется.",
	"{action} failed: {message}": "Не удалось выполнить действие «{action}»: {message}",
	"summarize": "создать конспект",
	"transcribe & summarize": "транскрибировать и создать конспект",

	Transcribing: "Транскрипция",
	"Transcribing \"{name}\"...": "Транскрибируется «{name}»…",
	"Saving transcript": "Сохранение транскрипции",
	"Cleaning up transcript": "Очистка транскрипции",
	"Generating summary": "Создание конспекта",
	"Saving results": "Сохранение результатов",
	"Recording saved as \"{name}\" - transcription is off.": "Запись сохранена как «{name}» — транскрипция отключена.",
	"Recording finished - transcription is off, and \"Save audio file\" is also off, so nothing was kept.":
		"Запись завершена, но транскрипция и сохранение аудиофайла отключены, поэтому ничего не сохранено.",
	"Warning: possible repetition-loop artifact detected in the transcript for \"{name}\".":
		"Предупреждение: в транскрипции «{name}» обнаружен возможный зацикленный повтор.",
	"Transcript ready for \"{name}\".": "Транскрипция «{name}» готова.",
	"Recording processed for \"{name}\" - transcript and summary are both off, nothing was kept.":
		"Запись «{name}» обработана, но транскрипция и конспект отключены, поэтому ничего не сохранено.",
	"Cleaning up transcript for \"{name}\"...": "Очищается транскрипция «{name}»…",
	"Generating summary for \"{name}\"...": "Создаётся конспект «{name}»…",
	"Summary ready for \"{name}\".": "Конспект «{name}» готов.",
	"Couldn't detect the note to insert into - creating a new file in \"{folder}\" instead.":
		"Не удалось определить заметку для вставки — вместо этого будет создан новый файл в «{folder}».",
	"the vault root": "корне хранилища",
	"Stopped.": "Остановлено.",
	"Stopped. The transcript so far was saved to \"{path}\".": "Остановлено. Полученная транскрипция сохранена в «{path}».",
	"The transcript was already produced and has been saved to \"{path}\" so it isn't lost. Fix the issue above, then re-run \"Transcribe & summarize\" on the audio file - or use the saved transcript directly.":
		"Транскрипция уже получена и сохранена в «{path}», поэтому она не потеряна. Исправьте указанную выше ошибку, затем снова запустите транскрипцию и создание конспекта для аудиофайла — либо используйте сохранённую транскрипцию напрямую.",
	"There's no text to summarize.": "Нет текста для создания конспекта.",
	"\"{path}\" exists but is not a folder.": "«{path}» существует, но не является папкой.",
	"## Full Transcript": "## Полная транскрипция",
	"Possible repetition-loop artifact detected in the transcript - review before trusting this summary.":
		"В транскрипции обнаружен возможный зацикленный повтор — проверьте её, прежде чем доверять конспекту.",

	"Extracting audio from video": "Извлечение аудио из видео",
	"Transcribing {completed} of {total} chunks": "Транскрибировано фрагментов: {completed} из {total}",
	"Transcribed {completed} of {total} chunks": "Транскрибировано фрагментов: {completed} из {total}",
	"Summarizing part {part} of {total}": "Создание конспекта: часть {part} из {total}",
	"Combining summary": "Объединение конспекта",
	"Summary complete": "Конспект готов",
	chunks: "фрагм.",
	steps: "этапов",
	"Request was cancelled.": "Запрос отменён.",
	"Request to {url} timed out after {seconds}s": "Время ожидания запроса к {url} истекло через {seconds} с",
	"The audio track couldn't be decoded. The file may not contain audio, or its media codec may not be supported by this version of Obsidian.":
		"Не удалось декодировать аудиодорожку. Возможно, файл не содержит аудио или его кодек не поддерживается этой версией Obsidian.",
	"The media file does not contain a usable audio track.": "Медиафайл не содержит пригодной аудиодорожки.",
	"This browser does not support any recordable audio format (MediaRecorder unavailable).":
		"Этот браузер не поддерживает ни одного формата записи аудио (MediaRecorder недоступен).",
	"Summary generation returned an empty response.": "Сервис создания конспекта вернул пустой ответ.",
	"Summary generation failed (HTTP {status}): {detail}": "Не удалось создать конспект (HTTP {status}): {detail}",
	"Transcription failed on chunk {chunk} (HTTP {status}): {detail}": "Не удалось транскрибировать фрагмент {chunk} (HTTP {status}): {detail}",
	"{label} API key is not set. Add it in Settings under \"{label}\", or switch the transcription provider.":
		"API-ключ {label} не задан. Добавьте его в настройках в разделе «{label}» или выберите другого провайдера транскрипции.",
	"Reuse is enabled, but the transcription API key is also empty - set one of the two keys":
		"Повторное использование ключа включено, но API-ключ транскрипции также пуст — задайте один из двух ключей",
	"Add it in Settings under Summary": "Добавьте его в настройках в разделе «Конспект»",
	"The {provider} API key is not set. {hint}.": "API-ключ {provider} не задан. {hint}.",
	"{provider} API key is not set. Add it in Settings under Summary.": "API-ключ {provider} не задан. Добавьте его в настройках в разделе «Конспект».",
	"{provider} API key is not set. Add it in Settings under \"{provider}\".":
		"API-ключ {provider} не задан. Добавьте его в настройках в разделе «{provider}».",
	"Transcription failed on chunk {chunk} (HTTP 413: payload too large). The \"{model}\" model has a smaller upload limit than the ~22MB chunk size this plugin targets. Try a different transcription model (e.g. \"whisper-1\") or lower your recording bitrate in Settings.":
		"Не удалось транскрибировать фрагмент {chunk} (HTTP 413: слишком большой запрос). У модели «{model}» ограничение загрузки меньше примерно 22 МБ, на которые рассчитано разделение в плагине. Выберите другую модель транскрипции, например whisper-1, или уменьшите битрейт записи в настройках.",

	Transcription: "Транскрипция",
	Summary: "Конспект",
	"Custom vocabulary": "Пользовательский словарь",
	Interface: "Интерфейс",
	"Output files": "Выходные файлы",
	Support: "Поддержка",
	"Transcription provider": "Провайдер транскрипции",
	"Speaking language": "Язык речи",
	"Keep transcript": "Сохранять транскрипцию",
	"Transcript folder": "Папка транскрипций",
	"Clean up transcript": "Очищать транскрипцию",
	"Cleanup prompt": "Промпт очистки",
	"Reset to default prompt": "Восстановить стандартный промпт",
	"Generate summary after transcription": "Создавать конспект после транскрипции",
	"Summary provider": "Провайдер конспекта",
	"Summary prompt": "Промпт конспекта",
	"Summary placement": "Размещение конспекта",
	"Summary folder": "Папка конспектов",
	"Vocabulary hints": "Подсказки словаря",
	Microphone: "Микрофон",
	"Audio bitrate": "Битрейт аудио",
	"Save audio file": "Сохранять аудиофайл",
	"Audio folder": "Папка аудио",
	"Silence auto-stop (minutes)": "Автоостановка при тишине (минуты)",
	"Max recording duration (hours)": "Максимальная длительность записи (часы)",
	"Confirm before starting (command/hotkey)": "Подтверждать запуск (команда/горячая клавиша)",
	"Confirm before stopping (command/hotkey)": "Подтверждать остановку (команда/горячая клавиша)",
	"Save results next to source audio": "Сохранять результаты рядом с исходным медиафайлом",
	"Transcript file name": "Имя файла транскрипции",
	"Transcript format": "Формат транскрипции",
	"Summary file name": "Имя файла конспекта",
	"Source media in summary": "Исходный медиафайл в конспекте",
	"Enjoying this plugin?": "Нравится плагин?",
	"Plain transcript": "Обычная транскрипция",
	"Markdown with timestamps": "Markdown с временными метками",
	"Structured JSON": "Структурированный JSON",
	"Embed player": "Встроить проигрыватель",
	"Link only": "Только ссылка",
	"Don't include": "Не добавлять",
	"Active note (fallback to new file)": "Активная заметка (иначе новый файл)",
	"Dedicated file": "Отдельный файл",
	"Auto-detect": "Автоопределение",
	"System default": "Системный по умолчанию",
	"Request microphone access & refresh device list": "Запросить доступ к микрофону и обновить список устройств",
	"Microphone {number}": "Микрофон {number}",
	"Must be between 0 and 2.": "Значение должно быть от 0 до 2.",
	"Must be greater than 0.": "Значение должно быть больше 0.",
	"Enter a file name.": "Введите имя файла.",
	"Leave off the file extension.": "Не указывайте расширение файла.",
	"Leave off the {extension} extension.": "Не указывайте расширение {extension}.",
	"Microphone access was denied or unavailable. Check your OS privacy settings for Obsidian.":
		"Доступ к микрофону запрещён или недоступен. Проверьте настройки конфиденциальности ОС для Obsidian.",
	"Could not list audio devices - see console for details.": "Не удалось получить список аудиоустройств — подробности смотрите в консоли.",
	"No microphones found. Grant microphone access and try again.": "Микрофоны не найдены. Разрешите доступ к микрофону и повторите попытку.",
	"32 kbps (default - smallest files)": "32 кбит/с (по умолчанию — минимальный размер)",
	"64 kbps (better quality, ~2x file size)": "64 кбит/с (лучше качество, примерно вдвое больше файл)",
	"128 kbps (best quality, ~4x file size)": "128 кбит/с (лучшее качество, примерно вчетверо больше файл)",
	Arabic: "Арабский",
	Chinese: "Китайский",
	Dutch: "Нидерландский",
	English: "Английский",
	Finnish: "Финский",
	French: "Французский",
	German: "Немецкий",
	Hindi: "Хинди",
	Indonesian: "Индонезийский",
	Italian: "Итальянский",
	Japanese: "Японский",
	Korean: "Корейский",
	Polish: "Польский",
	Portuguese: "Португальский",
	Russian: "Русский",
	Spanish: "Испанский",
	Swedish: "Шведский",
	Thai: "Тайский",
	Turkish: "Турецкий",
	Ukrainian: "Украинский",
	Vietnamese: "Вьетнамский",
	"Uses the OpenAI Whisper transcription API directly. 25MB size ceiling, handled via silence-aware chunking.":
		"Прямое подключение к API транскрипции OpenAI Whisper. Ограничение 25 МБ обходится разделением по паузам.",
	"Whisper model used for transcription.": "Модель Whisper для транскрипции.",
	"Routes Whisper transcription through OpenRouter - often cheaper. 25MB size ceiling, handled via silence-aware chunking.":
		"Транскрипция Whisper через OpenRouter — часто дешевле. Ограничение 25 МБ обходится разделением по паузам.",
	"OpenRouter model id, provider-prefixed (e.g. openai/whisper-1, not just whisper-1). See the id on ":
		"Идентификатор модели OpenRouter с префиксом провайдера (например, openai/whisper-1, а не просто whisper-1). Найдите его на ",
	"OpenRouter's model page": "странице модели OpenRouter",
	" (shown under the model name); that page links to other transcription models too.":
		" (указан под названием модели); там же есть ссылки на другие модели транскрипции.",
	"Uses the OpenAI Chat Completions API directly. Get a key from the ": "Прямое подключение к OpenAI Chat Completions API. Получить ключ можно на ",
	"OpenAI API keys page": "странице API-ключей OpenAI",
	"Model used to generate the structured summary from the transcript. See available models in the ":
		"Модель для создания структурированного конспекта транскрипции. Доступные модели перечислены в ",
	"OpenAI models docs": "документации моделей OpenAI",
	"Routes through OpenRouter - access to many models (including Anthropic and Google) via one key, often cheaper.":
		"Работа через OpenRouter: множество моделей, включая Anthropic и Google, доступны по одному ключу и часто дешевле.",
	"OpenRouter model id, provider-prefixed (e.g. openai/gpt-4o-mini, not just gpt-4o-mini). Browse available models on ":
		"Идентификатор модели OpenRouter с префиксом провайдера (например, openai/gpt-4o-mini, а не просто gpt-4o-mini). Доступные модели смотрите на ",
	"Uses Google's Gemini API directly, via its OpenAI-compatible endpoint. Get a key from ":
		"Прямое подключение к API Google Gemini через OpenAI-совместимый адрес. Получить ключ можно в ",
	"Google AI Studio": "Google AI Studio",
	"Gemini model used to generate the structured summary from the transcript. See available models in the ":
		"Модель Gemini для создания структурированного конспекта транскрипции. Доступные модели перечислены в ",
	"Gemini API docs": "документации API Gemini",
	"Language spoken in your recordings. The transcript is written in this language, not translated - setting this just improves accuracy and speed, especially for short or accented recordings. Leave on auto-detect if recordings mix languages or aren't in the list.":
		"Язык речи в записях. Транскрипция создаётся на этом языке без перевода; настройка лишь повышает точность и скорость, особенно для коротких записей и речи с акцентом. Выберите автоопределение для записей с несколькими языками или языком вне списка.",
	"Save the transcript in the format selected under Output files. Transcription still runs when summary generation is enabled, even if this is off. Turn on 'Save audio file' too, or a recording with this and summary generation both off keeps nothing.":
		"Сохранять транскрипцию в формате, выбранном в разделе «Выходные файлы». Если включено создание конспекта, транскрипция выполняется даже при отключённой настройке. Также включите сохранение аудиофайла, иначе при отключённом конспекте запись не сохранится.",
	"Vault folder where transcript files are saved. When 'Save results next to source audio' is enabled, this is the fallback for recordings without a saved audio file.":
		"Папка хранилища для файлов транскрипции. Если включено сохранение результатов рядом с исходным медиафайлом, эта папка используется для записей без сохранённого аудиофайла.",
	"Run the transcript through an LLM to remove filler words, false starts, and grammar mistakes before summarization. Saved timestamped formats keep the provider's original segment text aligned with the audio. Uses the provider/model configured under Summary below and adds one extra LLM call per recording.":
		"Перед созданием конспекта обработать транскрипцию языковой моделью: убрать слова-паразиты, оговорки и грамматические ошибки. В форматах с временными метками сохраняется исходный текст провайдера, синхронизированный с аудио. Использует провайдера и модель из раздела «Конспект» и добавляет один запрос к модели на запись.",
	"Instructions sent to the LLM to clean up the raw transcript. Customize the wording, but keep it from summarizing, shortening, or inventing content.":
		"Инструкции для языковой модели по очистке исходной транскрипции. Формулировку можно изменить, но модель не должна сокращать, пересказывать или выдумывать содержание.",
	"{provider} API key": "API-ключ {provider}",
	"Used for Whisper transcription. Also used for summary generation unless a separate summary API key is set below.":
		"Используется для транскрипции Whisper, а также для создания конспекта, если ниже не задан отдельный API-ключ.",
	"{provider} model": "Модель {provider}",
	"{provider} base URL": "Базовый URL {provider}",
	"Edit directly to point at a proxy or self-hosted endpoint.": "Измените адрес, чтобы использовать прокси или собственный сервер.",
	"When off, no summary LLM call is made and no summary note is created. Independent of 'Keep transcript' above - the transcript is still saved if that's on, even with summaries off.":
		"Если отключено, запрос к языковой модели не выполняется и заметка с конспектом не создаётся. Настройка не зависит от сохранения транскрипции: её по-прежнему можно сохранять без конспекта.",
	"Which LLM provider generates the structured summary from the transcript.": "Провайдер языковой модели для создания структурированного конспекта транскрипции.",
	"Instructions sent to the LLM to turn a transcript into a structured summary (Overview, Topics Discussed, Decisions Made, Action Items, Open Questions). Customize the wording, but keep it from inventing names/owners/dates not present in the transcript.":
		"Инструкции для языковой модели по созданию структурированного конспекта: обзор, обсуждённые темы, решения, задачи и открытые вопросы. Формулировку можно изменить, но модель не должна выдумывать имена, исполнителей и даты, которых нет в транскрипции.",
	"'Active note' inserts the summary at the cursor in the note that was open when recording stopped, falling back to a new note in the summary folder below when there isn't one. 'Dedicated file' always writes a new note in the summary folder, regardless of what's open.":
		"«Активная заметка» вставляет конспект в позицию курсора в заметке, открытой при остановке записи; если такой заметки нет, создаётся новый файл в папке конспектов. «Отдельный файл» всегда создаёт новую заметку в папке конспектов.",
	"Vault folder used for dedicated summary files and when no active note is available. When 'Save results next to source audio' is enabled, this is the fallback for recordings without a saved audio file.":
		"Папка хранилища для отдельных файлов конспекта и случаев, когда активная заметка недоступна. Если включено сохранение результатов рядом с исходным медиафайлом, эта папка используется для записей без сохранённого аудиофайла.",
	"Reuse transcription ({provider}) API key": "Использовать API-ключ транскрипции ({provider})",
	"Transcription is currently configured to call {provider} - reuse that same key for summary generation instead of a separate key here.":
		"Для транскрипции сейчас используется {provider}. Использовать тот же ключ для создания конспекта вместо отдельного ключа.",
	"{provider} temperature": "Температура {provider}",
	"Randomness of the generated summary, from 0 (deterministic, sticks close to the transcript) to 2 (more creative, more prone to inventing details). Default {value} favors accuracy.":
		"Степень вариативности конспекта: от 0 (предсказуемо и близко к транскрипции) до 2 (творчески, но выше риск выдуманных деталей). Значение по умолчанию {value} отдаёт приоритет точности.",
	"Comma-separated names, jargon, or project terms to reduce misrecognition of recurring vocabulary. Passed to the transcription provider where supported.":
		"Имена, жаргон и термины проекта через запятую. Помогают точнее распознавать повторяющуюся лексику и передаются провайдеру транскрипции, если он это поддерживает.",
	"Input device used when recording. Falls back to the system default if the saved device is unavailable.":
		"Устройство ввода для записи. Если сохранённое устройство недоступно, используется системное устройство по умолчанию.",
	"Recording quality vs. file size. Lower bitrates keep recordings under Whisper's 25MB ceiling for longer before chunking kicks in.":
		"Баланс качества записи и размера файла. Низкий битрейт позволяет дольше не превышать ограничение Whisper в 25 МБ до разделения записи на части.",
	"Always preserve the recorded audio to the vault, regardless of whether transcription or summarization succeeds. Recommended to leave on - it's the only guaranteed record if a downstream step fails.":
		"Всегда сохранять записанное аудио в хранилище независимо от результата транскрипции и создания конспекта. Рекомендуется оставить включённым: это единственная гарантированная копия при последующей ошибке.",
	"Vault folder audio recordings are saved to.": "Папка хранилища для сохранения аудиозаписей.",
	"Recording auto-stops after this many minutes of near-silence.": "Автоматически останавливать запись после указанного количества минут почти полной тишины.",
	"Hard backstop: recording always stops after this many hours, regardless of silence detection.":
		"Жёсткое ограничение: запись всегда останавливается через указанное количество часов независимо от обнаружения тишины.",
	"Ask for confirmation before starting a recording via the command palette or a hotkey, to guard against an accidental press. The ribbon icon always confirms separately, since dragging it to reorder can register as a click.":
		"Запрашивать подтверждение перед запуском записи через палитру команд или горячую клавишу. Значок на ленте всегда запрашивает подтверждение отдельно, поскольку его перетаскивание может засчитаться как нажатие.",
	"Ask for confirmation before stopping an in-progress recording via the command palette or a hotkey, to guard against an accidental press. The ribbon icon always confirms separately, since dragging it to reorder can register as a click.":
		"Запрашивать подтверждение перед остановкой записи через палитру команд или горячую клавишу. Значок на ленте всегда запрашивает подтверждение отдельно, поскольку его перетаскивание может засчитаться как нажатие.",
	"File names can't contain \\, /, :, *, ?, \", <, >, or |.": "Имена файлов не могут содержать \\, /, :, *, ?, \", <, > или |.",
	"Save transcript files and new summary notes in the same folder as the source media file. The configured transcript and summary folders remain the fallback when there is no saved source file.":
		"Сохранять файлы транскрипции и новые заметки с конспектом в папке исходного медиафайла. Если исходный файл не сохранён, используются настроенные папки транскрипций и конспектов.",
	"Name used for the transcript file. Use {name} for the source media file name; the selected format's extension is added automatically.":
		"Имя файла транскрипции. Используйте {name} для имени исходного медиафайла; расширение выбранного формата добавляется автоматически.",
	"Save the original plain transcript note, a readable Markdown transcript with timestamps, or structured JSON with timed segments for use by other plugins.":
		"Сохранять обычную заметку с транскрипцией, читаемый Markdown с временными метками или структурированный JSON с сегментами для других плагинов.",
	"Name used when the summary is written to a new note. Use {name} for the source media file name; the .md extension is added automatically.":
		"Имя новой заметки с конспектом. Используйте {name} для имени исходного медиафайла; расширение .md добавляется автоматически.",
	"Choose whether summaries include an embedded player, a link to the source audio or video, or no source reference.":
		"Выберите, добавлять ли в конспект встроенный проигрыватель, ссылку на исходное аудио или видео либо ничего не добавлять.",
	"If it's saved you time, consider supporting development on ": "Если плагин сэкономил вам время, поддержите разработку на ",
};

export function isRussianLocale(): boolean {
	return getLanguage().toLowerCase().startsWith("ru");
}

export function t(source: string, variables: Record<string, string | number> = {}): string {
	const template = isRussianLocale() ? (RU[source] ?? source) : source;
	return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in variables ? String(variables[key]) : match));
}
