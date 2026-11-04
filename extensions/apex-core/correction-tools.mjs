import {
  createReadToolDefinition,createWriteToolDefinition,createEditToolDefinition,createBashToolDefinition,
  createGrepToolDefinition,createFindToolDefinition,createLsToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {createEfficientTools} from '../apex-context/tools.mjs';
import {prepareCorrectableArguments} from './control.mjs';

/** Preserve selected Phase 1 definitions while correcting aliases before native validation. */
export function createCorrectionTools({cwd,contextFeatures=[]}) {
  const definitions=[createReadToolDefinition(cwd),createWriteToolDefinition(cwd),createEditToolDefinition(cwd),
    createBashToolDefinition(cwd),createGrepToolDefinition(cwd),createFindToolDefinition(cwd),createLsToolDefinition(cwd)];
  const overrides=new Map(createEfficientTools({cwd,features:new Set(contextFeatures)}).map(tool=>[tool.name,tool]));
  return definitions.map(native=>{
    const original=overrides.get(native.name)??native;
    return {...original,prepareArguments(input){
      let prepared=prepareCorrectableArguments(original.name,input);
      if(original.name==='edit'&&contextFeatures.includes('edit'))prepared={...prepared,
        edits:prepared.edits.map(edit=>({old_string:edit.oldText,new_string:edit.newText}))};
      return original.prepareArguments?original.prepareArguments(prepared):prepared;
    }};
  });
}
