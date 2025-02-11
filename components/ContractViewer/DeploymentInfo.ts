import { createContext, useCallback, useContext, useState } from 'react'

import solParser from '@solidity-parser/parser'
import * as AstTypes from '@solidity-parser/parser/src/ast-types'
import { type Abi } from 'abitype'
import { NextRouter } from 'next/router'
import { SourceDefinition } from 'types/ast'
import {
  EtherscanContractResponse,
  SolidityCompilerOutput,
  SoliditySettings,
} from 'types/contract'

import { findContract, flattenCode } from 'util/flatten'
import { solidityCompiler } from 'util/solc'

import EtherscanLoader from './EtherscanLoader'

export type ParseResult = AstTypes.SourceUnit & {
  errors?: any[]
  tokens?: any[]
}

export type DeploymentsCollection = {
  [address: string]: DeploymentInfo
}

// TODO: should probably move some of the contract code parts to another class
// it might be useful to have separate compilationInfo for separate deployments but
// this class is too big rn, can and probably should move code, abi, compilationInfo to
// a "SolidityContract" class

/**
 * DeploymentInfo represents an on-chain deployment:
 *
 * @property chainId (chain id as decimal number)
 * @property code (raw flattenned string for simplicity)
 * @property address (on-chain address, currently mainnet only)
 * @property context (optional reference to proxy deployment) [may be logical to move this out?]
 * @property impls (deployment references of proxy implementations or delegations)
 * @property mainContractPath (path to main contract in source code - taken from etherscan)
 * @property etherscanInfo (slightly parsed response from etherscan)
 * @property compilationInfo (need to decide if this is directly from etherscan
 *           or flattenned or post-processed code for accessibility)
 * @property abi (fetched from etherscan, sourcify or compiled with solcjs)
 * @property accessibleCode (publicized functions, etc.)
 * @property accessibleAbi (publicized functions, etc.)
 * @property accessibleRuntimeBytecode (accessible bytecode for eth_call overrides)
 * @property defTree (better structured definition tree, but also not perfect)
 */
export class DeploymentInfo {
  id: string
  chainId = 1
  code: string
  address: string
  context?: DeploymentInfo
  // TODO: support historic upgrades & diffing
  implementations: DeploymentsCollection = {}

  mainContractPath: string
  // originalPathLenses: any[] = []

  etherscanInfo: EtherscanContractResponse
  compilationInfo?: SolidityCompilerOutput
  storageLayout?: any

  ast?: ParseResult // TODO: types
  nodesById: { [id: number]: AstTypes.ASTNode } = {}
  nodesByType: { [type: string]: AstTypes.ASTNode[] } = {}
  astDefTree?: SourceDefinition

  abi: Abi

  // accessible props are output from the compiler after converting everything to public
  accessibleAbi?: Abi
  accessibleCode?: string
  accessibleRuntimeBytecode?: string

  constructor(
    etherscanInfo: EtherscanContractResponse,
    address: string,
    context?: DeploymentInfo,
  ) {
    this.id = Math.random().toString().slice(2, 10)
    this.etherscanInfo = etherscanInfo
    this.abi = JSON.parse(etherscanInfo.ABI)
    this.address = address
    this.context = context
    this.code = ''

    const contractPath = findContract(
      etherscanInfo.SourceCode,
      etherscanInfo.ContractName,
    )
    if (!contractPath) {
      throw 'failed to find contract...'
    }

    this.mainContractPath = contractPath

    this.code = flattenCode(
      etherscanInfo.SourceCode,
      contractPath,
      // this?.originalPathLenses || [],
    )

    this.ast = solParser.parse(this.code, {
      loc: true,
      range: true,
      tolerant: true,
    })

    // TODO: restore ast processing here
    // this.defTree = buildDefinitionTree(this.code)
    // this.processAst()
  }

  isImpl(): boolean {
    return !!this.context
  }

  getImplementations(): DeploymentInfo[] {
    return Object.values(this.implementations)
  }

  rootContext(): DeploymentInfo {
    return this.context ? this.context.rootContext() : this
  }

  // TODO: should move to AstProcessor maybe?
  processAst(node: any, parent?: any) {
    if (Array.isArray(node)) {
      node.map((child) => this.processAst(child, parent))
      return
    }

    if (!node?.nodeType) {
      return
    }

    if (!this.nodesByType[node.nodeType]) {
      this.nodesByType[node.nodeType] = []
    }
    this.nodesByType[node.nodeType].push(node)
    this.nodesById[node.id] = node
    node.parentId = parent?.id

    for (const key in node) {
      this.processAst(node[key], node)
    }
  }

  async compile(
    outputs: string[],
    settings?: SoliditySettings,
    version?: string,
  ) {
    if (!settings) {
      settings = {
        outputSelection: {
          '*': {
            '': [],
            '*': [],
          },
        },
      }
    }

    settings.outputSelection['*'][''] = (
      settings.outputSelection['*'][''] || []
    ).concat(outputs)
    settings.outputSelection['*']['*'] = (
      settings.outputSelection['*']['*'] || []
    ).concat(outputs)

    return solidityCompiler
      .compileCode(
        this.etherscanInfo.SourceCode,
        // if not specifying exact version,
        version || this.etherscanInfo.CompilerVersion,
        settings,
      )
      .then(({ result, error }: any) => {
        if (error || !result) {
          console.warn('could not compile', this.address, error)
          return { result, error }
        }

        this.compilationInfo = result

        // TODO: move storage layout processing elsewhere
        // console.log('outputs', outputs, result)
        if (outputs.includes('storageLayout')) {
          const targetName = this.etherscanInfo.ContractName
          for (const contractData of Object.values(result.contracts) as any[]) {
            if (contractData[targetName]) {
              this.storageLayout = contractData[targetName].storageLayout
              break
            }
          }
        }

        return { result, error }
      })
  }
}

export const DeploymentsContext = createContext<{
  deployments: DeploymentsCollection
  setDeployments: (deployments: DeploymentsCollection) => void
}>({
  deployments: {},
  setDeployments: () => {
    console.warn('missing DeploymentsContext provider')
  },
})

const updateRoute = (
  router: NextRouter,
  deployments: DeploymentsCollection,
) => {
  const query: { address?: string } = {}
  const addresses = Object.values(deployments)
    .map(({ address }) => address)
    .join(',')

  if (addresses) {
    query.address = addresses
    router.replace({ query })
  } else {
    // Clear the field
    router.replace({ query: {} })
  }
}

export const useDeployments = (router: NextRouter) => {
  const { deployments, setDeployments } = useContext(DeploymentsContext)
  const [selectedDeployment, setSelectedDeployment] = useState<
    DeploymentInfo | undefined
  >(undefined)
  const [reqCount, setReqCount] = useState(0)

  const loadDeployment = useCallback(
    async (
      address: string,
      context?: DeploymentInfo,
      loadImplementation = true,
      invalidateRoute = true,
    ) => {
      setReqCount(reqCount + 1)
      return EtherscanLoader.loadDeployment(address, context)
        .then(async (deployment: DeploymentInfo) => {
          // TODO: should we avoid overriding if it already exists?
          if (context) {
            context.implementations[address] = deployment
          } else {
            deployments[address] = deployment
          }

          setDeployments({ ...deployments })
          setSelectedDeployment(deployment)

          if (loadImplementation) {
            const impl = deployment.etherscanInfo?.Implementation as string
            if (impl) {
              /*await*/ loadDeployment(impl.toLowerCase(), deployment)
            }
          }

          const settings = deployment.etherscanInfo.SourceCode.settings
          const selectedOutputs = ['storageLayout']
          const ogVersion = deployment.etherscanInfo.CompilerVersion
          deployment
            .compile(selectedOutputs, settings, ogVersion)
            .then((data) => {
              if (!data || data.error) {
                // strip the 'v' prefix and '+commit..' suffix
                // this will choose the latest stable release of that version
                let shortVersion = ogVersion.split('+')[0].slice(1)
                if (shortVersion.startsWith('0.4.')) {
                  // solcjs versions 0.4.x have bugs, bump to latest stable release
                  // and hope for good luck
                  shortVersion = '0.4.26'
                }

                deployment
                  .compile(selectedOutputs, settings, shortVersion)
                  .then(() => {
                    setReqCount(reqCount - 1)
                  })
              } else {
                setReqCount(reqCount - 1)
              }
            })

          if (invalidateRoute) {
            updateRoute(router, deployments)
          }

          return deployment
        })
        .catch((err) => {
          setReqCount(reqCount - 1)
          throw err
        })
    },
    [deployments, setDeployments, reqCount, router],
  )

  const removeDeployment = (deployment: DeploymentInfo) => {
    const context = deployment.context
    if (context) {
      delete context.implementations[deployment.address]
    } else {
      delete deployments[deployment.address]
    }

    setDeployments({ ...deployments })
    if (selectedDeployment == deployment) {
      setSelectedDeployment(undefined)
    }
    updateRoute(router, deployments)
  }

  return {
    deployments,

    loadDeployment,
    removeDeployment,

    selectedDeployment,
    setSelectedDeployment,
    reqCount,
  }
}
