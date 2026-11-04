(function(){
 'use strict';
 const $=id=>document.getElementById(id);
 const fileInput=$('documentImportFile');
 if(!fileInput)return;
 let currentFile=null;
 const seenDocumentNumbers=new Set();
 const setStatus=(text,error=false)=>{const el=$('documentImportStatus');el.textContent=text;el.className='status '+(error?'error':'success');};
 const escapeHtml=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const toISO=(raw)=>{
   if(!raw)return '';
   const m=String(raw).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
   if(!m)return '';
   let y=Number(m[3]);if(y>2400)y-=543;else if(y<100)y+=2000;
   return String(y).padStart(4,'0')+'-'+String(Number(m[2])).padStart(2,'0')+'-'+String(Number(m[1])).padStart(2,'0');
 };
 const cleanLines=t=>t.split(/\r?\n/).map(x=>x.replace(/\s+/g,' ').trim()).filter(Boolean);
 function extractLines(lines){
   const found=[];
   const isSku=s=>/^(?:\d{3,5}|\d{1,4}\/\d{1,4})$/.test(s);
   const ignore=/^(?:รายการ|รหัส|ราคา|จานวน|จำนวน|ส่วนลด|รวม|เลขที่|วันที่|หน่วย|หน้า|โทร|ที่อยู่|ผู้|วิธี|วัน|ภาษี|บาท|ชุด|ชิ้น|ครั้ง|เครดิต|กำหนด|หมายเหตุ)/i;
   for(let i=0;i<lines.length;i++){
     const sku=lines[i].replace(/\s/g,'');
     if(!isSku(sku))continue;
     const before=lines.slice(Math.max(0,i-7),i);
     let name='';
     for(let j=before.length-1;j>=0;j--){
       const x=before[j];
       if(/[ก-๙A-Za-z]/.test(x)&&!ignore.test(x)&&!/^\d/.test(x)&&!/%$/.test(x)&&x.length>2){name=x;break;}
     }
     const near=lines.slice(Math.max(0,i-5),Math.min(lines.length,i+6));
     let qty=1;
     const unitQty=near.map(x=>x.match(/(\d+(?:\.\d+)?)\s*(?:ชุด|ชิ้น|ครั้ง|ชทด|ชคด|ครตชง)/i)).find(Boolean);
     if(unitQty)qty=Math.max(1,Math.round(Number(unitQty[1])));
     else{
       const nums=near.map(x=>x.match(/^\s*(\d+(?:\.\d+)?)\s*$/)).filter(Boolean).map(x=>Number(x[1])).filter(n=>n>0&&n<=100);
       if(nums.length)qty=Math.max(1,Math.round(nums[0]));
     }
     const service=sku==='4/2'||/ค่าบริการ|บริการจัดส่ง|จตดสทง|shipping|delivery service/i.test(name);
     found.push({sku,name:name||'ไม่สามารถอ่านชื่อสินค้าได้',quantity:qty,is_inventory:!service,unit:service?'ครั้ง':'ชุด'});
   }
   const seen=new Set();
   return found.filter(x=>{const k=x.sku+'|'+x.name;if(seen.has(k))return false;seen.add(k);return true;});
 }
 function parseText(text){
   const lines=cleanLines(text);
   const all=text.replace(/\s+/g,' ');
   const no=(all.match(/\b(?:Q|BK)\d{6}\/\d{4,6}\b/i)||[])[0]||'';
   const quote=/ใบเสนอราคา|quotation|\bQ\d{6}\//i.test(all);
   const reservation=/ใบจอง|\bBK\d{6}\//i.test(all);
   const dates=[...all.matchAll(/\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/g)].map(m=>m[1]);
   const day=(all.match(/Deliver\s*:\s*(\d+)\s*วน|Deliver\s*:\s*(\d+)\s*วัน/i)||[]);
   const validity=(all.match(/valid\s*for\s*:\s*(\d+)\s*วน|valid\s*for\s*:\s*(\d+)\s*วัน/i)||[]);
   const delivery=(lines.find(x=>/รับเอง|ขนส่ง|Flash|Kerry|J&T|ไปรษณีย์/i.test(x))||'').trim();
   const items=extractLines(lines);
   const warnings=[];
   if(!no)warnings.push('ไม่พบเลขที่เอกสารชัดเจน กรุณาตรวจสอบและกรอกเอง');
   if(!items.length)warnings.push('ไม่สามารถแยกรายการสินค้าได้จาก PDF นี้');
   if(reservation&&/รับเอง/.test(all)&&/Flash Express|ขนส่ง/i.test(all))warnings.push('ข้อมูลวิธีจัดส่งขัดแย้งกัน: ช่องวิธีจัดส่งระบุ “รับเอง” แต่หมายเหตุระบุ Flash Express กรุณาตรวจสอบ');
   if(items.some(x=>x.sku==='4/2'))warnings.push('พบ SKU 4/2 ซึ่งเป็นค่าบริการ ไม่ควรนับเป็นสินค้าในคลัง');\n   if(no&&seenDocumentNumbers.has(no))warnings.push('พบเลขที่เอกสารนี้ซ้ำกับไฟล์ที่อ่านไปแล้วในรอบการใช้งานนี้');
   return {type:quote?'QUOTATION':reservation?'RESERVATION':'UNKNOWN',number:no,date:toISO(dates[0]),dueDate:reservation?toISO(dates[1]):'',expiryDate:reservation?toISO(dates[2]):'',delivery,leadDays:day[1]||day[2]||'',validDays:validity[1]||validity[2]||'',items,warnings,rawText:text};
 }
 function render(result){
   $('diType').value=result.type;$('diNumber').value=result.number;$('diDate').value=result.date;$('diDueDate').value=result.dueDate;$('diExpiryDate').value=result.expiryDate;$('diDelivery').value=result.delivery;
   const warn=[...result.warnings];
   if(result.leadDays)warn.push('เอกสารระบุระยะเวลาจัดส่ง '+result.leadDays+' วัน (ยังไม่ใช่วันนัดส่งที่แน่นอน)');
   if(result.validDays)warn.push('ใบเสนอราคาระบุอายุ '+result.validDays+' วัน');
   $('documentImportWarnings').innerHTML=warn.length?'<strong>โปรดตรวจสอบ</strong><ul>'+warn.map(x=>'<li>'+escapeHtml(x)+'</li>').join('')+'</ul>':'<strong>ไม่พบคำเตือนจากการอ่านเบื้องต้น</strong>';
   $('documentImportWarnings').classList.remove('hidden');
   $('documentImportLines').innerHTML=result.items.length?result.items.map((x,i)=>'<article class="picking-line-card" data-di-row="'+i+'"><div class="form-grid"><div><label>SKU</label><input data-di-field="sku" value="'+escapeHtml(x.sku)+'"></div><div><label>ชื่อรายการ</label><input data-di-field="name" value="'+escapeHtml(x.name)+'"></div><div><label>จำนวน</label><input data-di-field="quantity" type="number" min="0" step="1" value="'+x.quantity+'"></div></div><label style="display:flex;align-items:center;gap:8px;margin-top:8px"><input data-di-field="inventory" type="checkbox" '+(x.is_inventory?'checked':'')+' style="width:auto"> นับเป็นสินค้าในคลัง (ยกเลิกสำหรับค่าบริการ)</label></article>').join(''):'<p class="error">ยังไม่พบรายการที่แยกได้ กรุณาตรวจสอบว่าเป็น PDF ที่มีข้อความ</p>';
   $('documentImportReview').classList.remove('hidden');
 }
 async function readPdf(file){
   if(!window.pdfjsLib)throw new Error('โหลดตัวอ่าน PDF ไม่สำเร็จ กรุณารีเฟรชหน้าเว็บแล้วลองใหม่');
   window.pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
   const data=new Uint8Array(await file.arrayBuffer());
   const pdf=await window.pdfjsLib.getDocument({data}).promise;
   const pages=[];
   for(let p=1;p<=pdf.numPages;p++){
     const page=await pdf.getPage(p),content=await page.getTextContent();
     pages.push(content.items.map(x=>x.str).filter(Boolean).join('\n'));
   }
   return pages.join('\n');
 }
 fileInput.addEventListener('change',async()=>{
   const file=fileInput.files?.[0];if(!file)return;
   currentFile=file;$('documentImportReview').classList.add('hidden');$('documentImportWarnings').classList.add('hidden');
   setStatus('กำลังอ่าน PDF: '+file.name+' ...');
   try{
     const text=await readPdf(file);
     if(!text.trim()){setStatus('ไฟล์นี้ไม่มีข้อความให้อ่าน อาจเป็น PDF ที่สแกนเป็นรูปภาพ (รุ่นทดลองนี้ยังไม่เปิด OCR) กรุณาใช้ PDF ที่ส่งออกจาก Business Plus โดยตรง',true);return;}
     const parsed=parseText(text);if(parsed.number)seenDocumentNumbers.add(parsed.number);render(parsed);
     setStatus('อ่านไฟล์สำเร็จ '+file.name+' · '+parsed.items.length+' รายการที่ตรวจพบ · ยังไม่มีการบันทึกข้อมูลใด ๆ');
   }catch(e){setStatus('อ่านไฟล์ไม่สำเร็จ: '+(e?.message||e),true);}
 });
 $('documentImportLines').addEventListener('input',e=>{
   const row=e.target.closest('[data-di-row]');if(!row)return;
   if(e.target.dataset.diField==='quantity'&&Number(e.target.value)<0)e.target.value='0';
 });
 $('documentImportResetBtn').addEventListener('click',()=>{
   fileInput.value='';currentFile=null;$('documentImportReview').classList.add('hidden');$('documentImportWarnings').classList.add('hidden');setStatus('ล้างผลการอ่านแล้ว กรุณาเลือกไฟล์ PDF ใหม่');
 });
 const tile=document.querySelector('[data-warehouse-action="DOC_IMPORT"]');
 tile?.addEventListener('click',e=>{
   e.stopImmediatePropagation();
   const panel=$('documentImportPanel');
   document.querySelectorAll('.workflow-panel').forEach(p=>{p.classList.add('hidden');p.classList.remove('workflow-popup-active');});
   panel.classList.remove('hidden');panel.classList.add('workflow-popup-active');panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');
   document.body.classList.add('workflow-modal-active');
   if(!panel.querySelector('.workflow-popup-close-row')){
     const row=document.createElement('div');row.className='workflow-popup-close-row';
     const close=document.createElement('button');close.type='button';close.className='workflow-popup-close';close.textContent='ปิด กลับเมนู';
     close.addEventListener('click',()=>{panel.classList.add('hidden');panel.classList.remove('workflow-popup-active');panel.removeAttribute('role');panel.removeAttribute('aria-modal');document.body.classList.remove('workflow-modal-active');});
     row.appendChild(close);panel.insertBefore(row,panel.firstChild);
   }
   $('documentImportReview').classList.add('hidden');setStatus('เลือกไฟล์ PDF เพื่อเริ่มอ่านเอกสาร');
 },true);
})();