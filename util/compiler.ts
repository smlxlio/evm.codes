import { BN } from 'ethereumjs-util'
import { IInstruction, IReferenceItem } from 'types'

import { EOF_FORK_NAME } from './constants'

// Version here: https://github.com/ethereum/solc-bin/blob/gh-pages/bin/list.txt
export const compilerVersion = `soljson-v0.8.27+commit.40a35a09`

/**
 * Gets target EVM version from a hardfork name
 *
 * @param forkName The String hardfork name
 * @returns The String matching target EVM version
 * @see https://docs.soliditylang.org/en/v0.8.15/using-the-compiler.html#target-options
 */
export const getTargetEvmVersion = (forkName: string | undefined) => {
  if (forkName === 'dao') {
    return 'homestead'
  }
  if (forkName === 'muirGlacier') {
    return 'berlin'
  }
  if (
    forkName &&
    ['arrowGlacier', 'grayGlacier', 'merge', 'shanghai', 'cancun'].includes(
      forkName,
    )
  ) {
    return 'london'
  } else if (forkName === EOF_FORK_NAME) {
    return 'prague'
  }
  return forkName
}

function toHexString(number: string, byteSize: number): string {
  let parsedNumber = null

  if (number.startsWith('0x') || number.startsWith('0X')) {
    if (!/^(0x|0X)[0-9a-fA-F]+$/.test(number)) {
      throw new Error('Not a valid hexadecimal number: ' + number)
    }

    parsedNumber = new BN(number.substring(2), 'hex')
  } else {
    if (!/^[0-9]+$/.test(number)) {
      throw new Error('Not a valid decimal number: ' + number)
    }

    parsedNumber = new BN(number)
  }

  if (parsedNumber.byteLength() > byteSize) {
    throw new Error('Value is too big for ' + byteSize + ' byte(s): ' + number)
  }

  return parsedNumber.toString('hex', byteSize * 2)
}

/**
 * Gets bytecode from mnemonic
 *
 * @param code The string code
 * @param opcodes The IReferenceItem array of opcodes
 * @returns The string bytecode
 */
export const getBytecodeFromMnemonic = (
  code: string,
  opcodes: IReferenceItem[],
) => {
  let bytecode = ''
  const lines = code.split('\n')

  // eslint-disable-next-line @typescript-eslint/prefer-for-of
  for (let i = 0; i < lines.length; ++i) {
    const line = lines[i]
      .replace(/\/\/.*/, '')
      .trim()
      .toUpperCase()

    if (line.length === 0) {
      continue
    }

    if (line !== 'PUSH0' && line.startsWith('PUSH')) {
      const parts = line.split(/\s+/)

      if (parts.length !== 2) {
        throw new Error('Expect PUSH instruction followed by a number: ' + line)
      }

      const code = opcodes.find((opcode: IReferenceItem) => {
        return opcode.name === parts[0]
      })

      if (typeof code === 'undefined') {
        throw new Error('Unknown mnemonic: ' + parts[0])
      }

      const number = parseInt(parts[0].substring(4))
      bytecode += code.opcodeOrAddress + toHexString(parts[1], number)
    } else {
      const code = opcodes.find((opcode: IReferenceItem) => {
        return opcode.name === line
      })
      if (typeof code === 'undefined') {
        throw new Error('Unknown mnemonic: ' + line)
      }

      bytecode += code.opcodeOrAddress
    }
  }

  return bytecode
}

/**
 * Gets mnemonic from instructions
 * @param instructions The IInstruction array of current instructions
 * @param opcodes The IReferenceItem array of opcodes
 * @returns the mnemonic code
 */
export const getMnemonicFromBytecode = (
  instructions: IInstruction[],
  opcodes: IReferenceItem[],
): string => {
  if (instructions.length === 0) {
    return ''
  }

  const opcodeMap: Record<string, string> = {}
  opcodes.forEach((c) => {
    opcodeMap[c.name as string] = c.opcodeOrAddress
  })

  return instructions
    .map((i) => `${opcodeMap[i.name]}${i.value || ''}`)
    .join('')
}

/**
 * Get the editable bytecode lines from the instructions
 * @param instructions The IInstruction array of current instructions
 * @returns the editable bytecode lines
 */
export const getBytecodeLinesFromInstructions = (
  instructions: IInstruction[],
): string => {
  if (instructions.length === 0) {
    return ''
  }

  return instructions
    .map((i) => `${i.name}${i.value ? ' 0x' + i.value : ''}`)
    .join('\n')
}
