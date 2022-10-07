import { parseHTML } from 'linkedom'
import * as _ from 'underscore'
import { SentenceTokenizer, WordPunctTokenizer } from 'natural'
import { htmlToText } from 'html-to-text'

// this code needs to be kept in sync with the
// frontend code in: useReadingProgressAnchor

export interface HtmlInput {
  title?: string
  content: string
  options: SSMLOptions
}

export interface Utterance {
  idx: string
  text: string
  wordOffset: number
  wordCount: number
  voice?: string
}

export interface SpeechFile {
  wordCount: number
  language: string
  defaultVoice: string
  utterances: Utterance[]
}

export type SSMLItem = {
  open: string
  close: string
  textItems: string[]
  idx: number
  voice?: string
}

export type SSMLOptions = {
  primaryVoice?: string
  secondaryVoice?: string
  rate?: string
  language?: string
}

const DEFAULT_LANGUAGE = 'en-US'
const DEFAULT_VOICE = 'en-US-JennyNeural'
const DEFAULT_SECONDARY_VOICE = 'en-US-GuyNeural'
const DEFAULT_RATE = '1.0'

const ANCHOR_ELEMENTS_BLOCKED_ATTRIBUTES = [
  'omnivore-highlight-id',
  'data-twitter-tweet-id',
  'data-instagram-id',
]

function ssmlTagsForTopLevelElement() {
  return {
    opening: `<break time="250ms"/>`,
  }
}

const TOP_LEVEL_TAGS = [
  'P',
  'BLOCKQUOTE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'LI',
]

function parseDomTree(pageNode: Element) {
  if (!pageNode || pageNode.childNodes.length == 0) {
    console.log('no child nodes found')
    return []
  }

  const nodesToVisitStack = [pageNode]
  const visitedNodeList = []

  while (nodesToVisitStack.length > 0) {
    const currentNode = nodesToVisitStack.pop()
    if (
      currentNode?.nodeType !== 1 /* Node.ELEMENT_NODE */ ||
      // Avoiding dynamic elements from being counted as anchor-allowed elements
      ANCHOR_ELEMENTS_BLOCKED_ATTRIBUTES.some((attrib) =>
        currentNode.hasAttribute(attrib)
      )
    ) {
      continue
    }

    visitedNodeList.push(currentNode)
    ;[].slice
      .call(currentNode.childNodes)
      .reverse()
      .forEach(function (node) {
        nodesToVisitStack.push(node)
      })
  }

  visitedNodeList.shift()
  visitedNodeList.forEach((node, index) => {
    // We start at index 3, because the frontend starts two nodes above us
    // on the #readability-page-1 element that wraps the entire content.
    node.setAttribute('data-omnivore-anchor-idx', (index + 3).toString())
  })
  return visitedNodeList
}

function emit(textItems: string[], text: string) {
  textItems.push(text)
}

const cleanText = (text: string): string => {
  return stripEmojis(_.escape(text.replace(/\s+/g, ' ')))
}

function cleanTextNode(textNode: ChildNode): string {
  return cleanText(textNode.textContent ?? '')
}

function emitTextNode(
  textItems: string[],
  cleanedText: string,
  textNode: ChildNode
) {
  const ssmlElement =
    textNode.parentNode?.nodeName === 'B' ? 'emphasis' : undefined
  if (!cleanedText) {
    return
  }

  if (ssmlElement) {
    emit(textItems, `<${ssmlElement}>`)
  }
  emit(textItems, `${cleanedText.replace(/\s+/g, ' ')}`)
  if (ssmlElement) {
    emit(textItems, `</${ssmlElement}>`)
  }
}

function emitElement(
  textItems: string[],
  element: Element,
  isTopLevel: boolean
) {
  const SKIP_TAGS = [
    'SCRIPT',
    'STYLE',
    'IMG',
    'FIGURE',
    'FIGCAPTION',
    'IFRAME',
    'CODE',
  ]

  const topLevelTags = ssmlTagsForTopLevelElement()
  const idx = element.getAttribute('data-omnivore-anchor-idx')
  let maxVisitedIdx = Number(idx)

  if (isTopLevel) {
    emit(textItems, topLevelTags.opening)
  }

  for (const child of Array.from(element.childNodes)) {
    if (SKIP_TAGS.indexOf(child.nodeName) >= 0) {
      continue
    }

    if (
      child.nodeType == 3 /* Node.TEXT_NODE */ &&
      (child.textContent?.length ?? 0) > 0
    ) {
      const cleanedText = cleanTextNode(child)
      if (idx && cleanedText.length > 1) {
        // Make sure it's more than just a space
        emit(textItems, `<bookmark mark="${idx}"/>`)
      }
      emitTextNode(textItems, cleanedText, child)
    }
    if (child.nodeType == 1 /* Node.ELEMENT_NODE */) {
      maxVisitedIdx = emitElement(textItems, child as HTMLElement, false)
    }
  }

  return Number(maxVisitedIdx)
}

export const startSsml = (options: SSMLOptions, element?: Element): string => {
  const voice =
    element?.nodeName === 'BLOCKQUOTE'
      ? options.secondaryVoice ?? DEFAULT_SECONDARY_VOICE
      : options.primaryVoice ?? DEFAULT_VOICE
  return `<speak xmlns="http://www.w3.org/2001/10/synthesis" version="1.0" xml:lang="${
    options.language || DEFAULT_LANGUAGE
  }"><voice name="${voice}"><prosody rate="${options.rate || DEFAULT_RATE}">`
}

export const endSsml = (): string => {
  return `</prosody></voice></speak>`
}

const hasSignificantText = (node: ChildNode): boolean => {
  let text = ''
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3 /* Node.TEXT_NODE */) {
      text += child.textContent
    }
  }
  return text.trim().length > 0
}

export const ssmlItemText = (item: SSMLItem): string => {
  return [item.open, ...item.textItems, item.close].join('')
}

export const htmlToSsmlItems = (
  html: string,
  options: SSMLOptions
): SSMLItem[] => {
  console.log('creating ssml with options', options)

  const dom = parseHTML(html)
  const body = dom.document.querySelector('#readability-page-1')
  if (!body) {
    throw new Error('Unable to parse HTML document')
  }

  const parsedNodes = parseDomTree(body)
  if (parsedNodes.length < 1) {
    throw new Error('No HTML nodes found')
  }

  const items: SSMLItem[] = []
  for (let i = 3; i < parsedNodes.length + 3; i++) {
    const textItems: string[] = []
    const node = parsedNodes[i - 3]

    if (TOP_LEVEL_TAGS.includes(node.nodeName) || hasSignificantText(node)) {
      const idx = i
      i = emitElement(textItems, node, true)
      items.push({
        open: startSsml(options, node),
        close: endSsml(),
        textItems: textItems,
        idx,
        voice:
          node.nodeName === 'BLOCKQUOTE' ? options.secondaryVoice : undefined,
      })
    }
  }

  return items
}

export const stripEmojis = (text: string): string => {
  const emojiRegex =
    /(?![*#0-9]+)[\p{Emoji}\p{Emoji_Modifier}\p{Emoji_Component}\p{Emoji_Modifier_Base}\p{Emoji_Presentation}]/gu
  return text.replace(emojiRegex, '').replace(/\s+/g, ' ')
}

const textToUtterances = ({
  tokenizer,
  idx,
  textItems,
  wordOffset,
  voice,
  isHtml = true,
}: {
  tokenizer: WordPunctTokenizer
  idx: string
  textItems: string[]
  wordOffset: number
  voice?: string
  isHtml?: boolean
}): Utterance[] => {
  let text = textItems.join('')
  if (!isHtml) {
    // for title
    return [
      {
        idx,
        text,
        wordOffset,
        wordCount: tokenizer.tokenize(text).length,
        voice,
      },
    ]
  }

  const utterances: Utterance[] = []
  try {
    text = htmlToText(text, { wordwrap: false })
  } catch (err) {
    console.error(
      'Unable to convert HTML to text, html:',
      text,
      ', error:',
      err
    )
    text = parseHTML(text).document.documentElement.textContent ?? text
    console.info('Converted HTML to text:', text)
  }

  const MAX_CHARS = 256
  const sentenceTokenizer = new SentenceTokenizer()
  const sentences = sentenceTokenizer.tokenize(text)
  let currentText = ''
  // split text to max 256 chars per utterance and
  // use nlp lib to detect sentences and
  // avoid splitting words and sentences
  sentences.forEach((sentence, i) => {
    if (i < sentences.length - 1) {
      // add space to the end of sentence
      sentence += ' '
    }
    const nextText = currentText + sentence
    if (nextText.length > MAX_CHARS) {
      if (currentText.length > 0) {
        const wordCount = tokenizer.tokenize(currentText).length
        utterances.push({
          idx,
          text: currentText,
          wordOffset,
          wordCount,
          voice,
        })
        wordOffset += wordCount
        currentText = sentence
      } else {
        const wordCount = tokenizer.tokenize(sentence).length
        utterances.push({
          idx,
          text: sentence,
          wordOffset,
          wordCount,
          voice,
        })
        wordOffset += wordCount
      }
    } else {
      currentText = nextText
    }
    if (i === sentences.length - 1 && currentText.length > 0) {
      utterances.push({
        idx,
        text: currentText,
        wordOffset,
        wordCount: tokenizer.tokenize(currentText).length,
        voice,
      })
    }
  })

  return utterances
}

export const htmlToSpeechFile = (htmlInput: HtmlInput): SpeechFile => {
  const { title, content, options } = htmlInput
  console.log('creating speech file with options:', options)
  const language = options.language || DEFAULT_LANGUAGE
  const defaultVoice = options.primaryVoice || DEFAULT_VOICE

  const dom = parseHTML(content)
  const body = dom.document.querySelector('#readability-page-1')
  if (!body) {
    console.log('No HTML body found')
    return {
      wordCount: 0,
      language,
      defaultVoice,
      utterances: [],
    }
  }

  const parsedNodes = parseDomTree(body)
  if (parsedNodes.length < 1) {
    console.log('No HTML nodes found')
    return {
      wordCount: 0,
      language,
      defaultVoice,
      utterances: [],
    }
  }

  const tokenizer = new WordPunctTokenizer()
  const utterances: Utterance[] = []
  let wordOffset = 0
  if (title) {
    // first utterances is the title
    const titleUtterance = textToUtterances({
      tokenizer,
      idx: '',
      textItems: [cleanText(title)], // title could have HTML entity names like & or emoji
      wordOffset,
      isHtml: false,
    })[0]
    utterances.push(titleUtterance)
    wordOffset += titleUtterance.wordCount
  }

  // start at 3 to skip the #readability-content and #readability-page-1 elements
  for (let i = 3; i < parsedNodes.length + 3; i++) {
    const textItems: string[] = []
    const node = parsedNodes[i - 3]

    if (TOP_LEVEL_TAGS.includes(node.nodeName) || hasSignificantText(node)) {
      // use paragraph as anchor
      const idx = i.toString()
      i = emitElement(textItems, node, true)
      const newUtterances = textToUtterances({
        tokenizer,
        idx,
        textItems,
        wordOffset,
        voice:
          node.nodeName === 'BLOCKQUOTE' ? options.secondaryVoice : undefined,
      })
      const wordCount = newUtterances.reduce((acc, u) => acc + u.wordCount, 0)
      wordCount > 0 && utterances.push(...newUtterances)
      wordOffset += wordCount
    }
  }

  return {
    wordCount: wordOffset,
    language,
    defaultVoice,
    utterances,
  }
}