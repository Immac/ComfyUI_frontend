import type {
  ExecutableLGraphNode,
  ExecutionId,
  LGraph,
  NodeId
} from '@comfyorg/litegraph'
import {
  ExecutableNodeDTO,
  LGraphEventMode,
  SubgraphNode
} from '@comfyorg/litegraph'

import type {
  ComfyApiWorkflow,
  ComfyWorkflowJSON
} from '@/schemas/comfyWorkflowSchema'

import { ExecutableGroupNodeDTO, isGroupNode } from './executableGroupNodeDto'
import { compressWidgetInputSlots } from './litegraphUtil'

/**
 * Recursively target node's parent nodes to the new output.
 * @param nodeId The node id to add.
 * @param oldOutput The old output.
 * @param newOutput The new output.
 * @returns The new output.
 */
function recursiveAddNodes(
  nodeId: NodeId,
  oldOutput: ComfyApiWorkflow,
  newOutput: ComfyApiWorkflow
) {
  const currentId = String(nodeId)
  const currentNode = oldOutput[currentId]!
  if (newOutput[currentId] == null) {
    newOutput[currentId] = currentNode
    for (const inputValue of Object.values(currentNode.inputs || [])) {
      if (Array.isArray(inputValue)) {
        recursiveAddNodes(inputValue[0], oldOutput, newOutput)
      }
    }
  }
  return newOutput
}

/**
 * Converts the current graph workflow for sending to the API.
 * @note Node widgets are updated before serialization to prepare queueing.
 *
 * @param graph The graph to convert.
 * @param options The options for the conversion.
 *  - `sortNodes`: Whether to sort the nodes by execution order.
 *  - `queueNodeIds`: The output nodes to execute. Execute all output nodes if not provided.
 * @returns The workflow and node links
 */
export const graphToPrompt = async (
  graph: LGraph,
  options: { sortNodes?: boolean; queueNodeIds?: NodeId[] } = {}
): Promise<{ workflow: ComfyWorkflowJSON; output: ComfyApiWorkflow }> => {
  const { sortNodes = false, queueNodeIds } = options

  for (const node of graph.computeExecutionOrder(false)) {
    const innerNodes = node.getInnerNodes
      ? node.getInnerNodes(new Map())
      : [node]
    for (const innerNode of innerNodes) {
      if (innerNode.isVirtualNode) {
        innerNode.applyToGraph?.()
      }
    }
  }

  const workflow = graph.serialize({ sortNodes })

  // Remove localized_name from the workflow
  for (const node of workflow.nodes) {
    for (const slot of node.inputs ?? []) {
      delete slot.localized_name
    }
    for (const slot of node.outputs ?? []) {
      delete slot.localized_name
    }
  }

  compressWidgetInputSlots(workflow)
  workflow.extra ??= {}
  workflow.extra.frontendVersion = __COMFYUI_FRONTEND_VERSION__

  const nodeDtoMap = new Map<ExecutionId, ExecutableLGraphNode>()
  for (const node of graph.computeExecutionOrder(false)) {
    const dto: ExecutableLGraphNode = isGroupNode(node)
      ? new ExecutableGroupNodeDTO(node, [], nodeDtoMap)
      : new ExecutableNodeDTO(
          node,
          [],
          nodeDtoMap,
          node instanceof SubgraphNode ? node : undefined
        )

    for (const innerNode of dto.getInnerNodes()) {
      nodeDtoMap.set(innerNode.id, innerNode)
    }

    nodeDtoMap.set(dto.id, dto)
  }

  let output: ComfyApiWorkflow = {}
  // Process nodes in order of execution
  for (const node of nodeDtoMap.values()) {
    // Don't serialize muted nodes
    if (
      node.isVirtualNode ||
      node.mode === LGraphEventMode.NEVER ||
      node.mode === LGraphEventMode.BYPASS
    ) {
      continue
    }

    const inputs: ComfyApiWorkflow[string]['inputs'] = {}
    const { widgets } = node

    // Store all widget values
    if (widgets) {
      for (const [i, widget] of widgets.entries()) {
        if (!widget.name || widget.options?.serialize === false) continue

        const widgetValue = widget.serializeValue
          ? await widget.serializeValue(node, i)
          : widget.value
        // By default, Array values are reserved to represent node connections.
        // We need to wrap the array as an object to avoid the misinterpretation
        // of the array as a node connection.
        // The backend automatically unwraps the object to an array during
        // execution.
        inputs[widget.name] = Array.isArray(widgetValue)
          ? {
              __value__: widgetValue
            }
          : widgetValue
      }
    }

    // Store all node links
    for (const [i, input] of node.inputs.entries()) {
      const resolvedInput = node.resolveInput(i)
      if (!resolvedInput) continue

      // Resolved to an actual widget value rather than a node connection
      if (resolvedInput.widgetInfo) {
        const { value } = resolvedInput.widgetInfo
        inputs[input.name] = Array.isArray(value) ? { __value__: value } : value
        continue
      }

      inputs[input.name] = [
        String(resolvedInput.origin_id),
        // @ts-expect-error link.origin_slot is already number.
        parseInt(resolvedInput.origin_slot)
      ]
    }

    output[String(node.id)] = {
      inputs,
      // TODO(huchenlei): Filter out all nodes that cannot be mapped to a
      // comfyClass.
      class_type: node.comfyClass!,
      // Ignored by the backend.
      _meta: {
        title: node.title
      }
    }
  }

  // Remove inputs connected to removed nodes
  for (const { inputs } of Object.values(output)) {
    for (const [i, input] of Object.entries(inputs)) {
      if (Array.isArray(input) && input.length === 2 && !output[input[0]]) {
        delete inputs[i]
      }
    }
  }

  // Partial execution
  if (queueNodeIds?.length) {
    const newOutput = {}
    for (const queueNodeId of queueNodeIds) {
      recursiveAddNodes(queueNodeId, output, newOutput)
    }
    output = newOutput
  }

  return { workflow: workflow as ComfyWorkflowJSON, output }
}
