# Embedded in the agent. Only a loopback endpoint and a per-launch desktop
# credential are passed in the environment; the deployment token stays in Go.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Net.Http
[System.Windows.Forms.Application]::EnableVisualStyles()
$client = New-Object System.Net.Http.HttpClient
$client.Timeout = [TimeSpan]::FromSeconds(5)
$client.DefaultRequestHeaders.Add('X-Rippel-Desktop-Token', $env:RIPPEL_DESKTOP_TOKEN)
$base = $env:RIPPEL_DESKTOP_URL
$parentProcess = Get-Process -Id ([int]$env:RIPPEL_DESKTOP_PARENT)
# Shared palette from apps/web/src/styles/tokens.css.
$ground = [Drawing.ColorTranslator]::FromHtml('#0d1014')
$panel = [Drawing.ColorTranslator]::FromHtml('#12181c')
$ink = [Drawing.ColorTranslator]::FromHtml('#dceef2')
$muted = [Drawing.ColorTranslator]::FromHtml('#9fb3ba')
$accent = [Drawing.ColorTranslator]::FromHtml('#9ccfd8')
$form = New-Object Windows.Forms.Form
$form.Text = 'rippel agent'
$form.ClientSize = New-Object Drawing.Size(520,580)
$form.MinimumSize = New-Object Drawing.Size(536,619)
$form.BackColor = $ground
$form.ForeColor = $ink
$form.Font = New-Object Drawing.Font('Segoe UI',10)
$form.StartPosition = 'Manual'
$area = [Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Location = New-Object Drawing.Point(($area.Right-$form.Width-16),($area.Bottom-$form.Height-16))
$form.ShowInTaskbar = $false
function Label($text,$x,$y,$width,$height) {
 $c = New-Object Windows.Forms.Label
 $c.Text=$text; $c.SetBounds($x,$y,$width,$height); $form.Controls.Add($c)
 return $c
}
$title = Label 'rippel / agent' 24 20 460 32
$title.Font = New-Object Drawing.Font('Segoe UI',18)
$status = Label 'Connecting to the local agent...' 24 68 460 28
$status.ForeColor = $accent
$server = Label '' 24 100 460 42
$server.ForeColor = $muted
$jobsTitle = Label 'Current jobs and queue' 24 150 460 24
$list = New-Object Windows.Forms.ListView
$list.SetBounds(24,180,472,218)
$list.Anchor = 'Top,Bottom,Left,Right'
$list.View='Details'; $list.FullRowSelect=$true; $list.BackColor=$panel; $list.ForeColor=$ink
$list.BorderStyle='FixedSingle'; $list.HeaderStyle='Nonclickable'
[void]$list.Columns.Add('State',105); [void]$list.Columns.Add('Job / maintenance task',340)
$form.Controls.Add($list)
$detail = Label 'Loading queue and maintenance tasks...' 24 408 472 44
$detail.Anchor = 'Bottom,Left,Right'; $detail.ForeColor=$muted
$note = Label 'Pausing blocks remote management and check-ins. ComfyUI jobs and accepted maintenance work continue.' 24 460 472 44
$note.Anchor='Bottom,Left,Right'; $note.ForeColor=$muted
$toggle = New-Object Windows.Forms.Button
$toggle.Text='Pause agent'; $toggle.SetBounds(24,520,160,36)
$toggle.Anchor='Bottom,Left'; $toggle.FlatStyle='Flat'; $toggle.BackColor=$accent; $toggle.ForeColor=$ground
$toggle.Enabled=$false; $form.Controls.Add($toggle)
$close = New-Object Windows.Forms.Button
$close.Text='Hide to tray'; $close.SetBounds(336,520,160,36)
$close.Anchor='Bottom,Right'; $close.FlatStyle='Flat'; $form.Controls.Add($close)
$close.Add_Click({$form.Hide()})
$script:exiting=$false
$form.Add_FormClosing({param($sender,$event) if(-not $script:exiting){$event.Cancel=$true; $form.Hide()}})
$tray = New-Object Windows.Forms.NotifyIcon
$tray.Icon=[Drawing.SystemIcons]::Application
$tray.Text='rippel agent - connecting'
$tray.Visible=$true
$menu = New-Object Windows.Forms.ContextMenuStrip
$open = $menu.Items.Add('Open rippel agent')
$open.Add_Click({$form.Show(); $form.Activate()})
$quit = $menu.Items.Add('Quit agent...')
$tray.ContextMenuStrip=$menu
$tray.Add_MouseClick({param($sender,$event) if($event.Button -eq 'Left'){$form.Show(); $form.Activate()}})
$script:actionError=''
$script:paused=$false
$script:request=$null
$script:action=$null
$script:showRequest=$null
$script:lastPoll=[DateTime]::MinValue
function Start-Action($path) {
 if($null -ne $script:action){return}
 $toggle.Enabled=$false; $quit.Enabled=$false
 $script:actionError=''
 $detail.Text='Applying change...'
 $script:action=$client.PostAsync($base+$path,(New-Object System.Net.Http.StringContent('')))
}
$toggle.Add_Click({if($script:paused){Start-Action '/resume'}else{Start-Action '/pause'}})
$quit.Add_Click({
 $answer=[Windows.Forms.MessageBox]::Show($form,'Quit the agent until you launch it again or sign in? ComfyUI keeps running.','Quit rippel agent','YesNo','Question')
 if($answer -eq 'Yes'){Start-Action '/quit'}
})
function Add-Row($state,$text) {
 $row=New-Object Windows.Forms.ListViewItem($state)
 [void]$row.SubItems.Add($text); [void]$list.Items.Add($row)
}
$timer = New-Object Windows.Forms.Timer
$timer.Interval=200
$timer.Add_Tick({
 try {
  if($parentProcess.HasExited){$script:exiting=$true; [Windows.Forms.Application]::Exit(); return}
  if($null -ne $script:action -and $script:action.IsCompleted){
   try {
    $response=$script:action.GetAwaiter().GetResult()
    $body=$response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
    if(-not $response.IsSuccessStatusCode){throw $body.message}
    $detail.Text='Change saved.'
   } catch {$script:actionError='Could not apply change: '+$_.Exception.Message; $detail.Text=$script:actionError}
   finally {if($null -ne $response){$response.Dispose()}; $script:action=$null; $quit.Enabled=$true; $script:lastPoll=[DateTime]::MinValue}
  }
  if($null -ne $script:showRequest -and $script:showRequest.IsCompleted){
   try {$response=$script:showRequest.GetAwaiter().GetResult(); $body=$response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json; if($body.show){$form.Show();$form.Activate()}} catch {} finally {if($null -ne $response){$response.Dispose()}; $script:showRequest=$null}
  }
  if($null -ne $script:request -and $script:request.IsCompleted){
   try {
    $response=$script:request.GetAwaiter().GetResult()
    [void]$response.EnsureSuccessStatusCode()
    $data=$response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
    $script:paused=$data.paused
    $status.Text='Agent online / '+$data.connection
    $tray.Text=('rippel / '+$data.connection)
    $tray.Icon=if($data.paused){[Drawing.SystemIcons]::Warning}elseif($data.connection -eq 'Connected'){[Drawing.SystemIcons]::Information}else{[Drawing.SystemIcons]::Application}
    $server.Text=$data.hostname+"`r`n"+$data.server
    $toggle.Text=if($data.paused){'Resume agent'}else{'Pause agent'}
    $toggle.Enabled=($null -eq $script:action)
    $list.BeginUpdate(); $list.Items.Clear()
    if($data.queueError){Add-Row 'Unknown' $data.queueError}else{
     foreach($id in $data.queue.running){Add-Row 'Running' $id}
     foreach($id in $data.queue.pending){Add-Row 'Queued' $id}
     if(($data.queue.running.Count+$data.queue.pending.Count) -eq 0){Add-Row 'Idle' 'No ComfyUI jobs queued'}
    }
    foreach($task in $data.tasks){Add-Row $task.status ($task.kind+' / '+$task.id)}
    $list.EndUpdate()
    $time=([DateTime]$data.observedAt).ToLocalTime().ToString('HH:mm:ss')
    $detail.Text='Updated '+$time
    if($data.checkin.error){$detail.Text+="`r`n"+$data.checkin.error}
    if($script:actionError){$detail.Text=$script:actionError}
   } catch {
    $status.Text='Local agent unavailable / showing last results'
    $tray.Text='rippel / local agent unavailable'; $toggle.Enabled=$false
    $detail.Text='Could not refresh status. Retrying...'
   } finally {if($null -ne $response){$response.Dispose()}; $script:request=$null}
  }
  if($null -eq $script:request -and ([DateTime]::Now-$script:lastPoll).TotalSeconds -ge 3){
   $script:lastPoll=[DateTime]::Now
   $script:request=$client.GetAsync($base+'/status')
   if($null -eq $script:showRequest){$script:showRequest=$client.GetAsync($base+'/show')}
  }
 } catch {$detail.Text=$_.Exception.Message}
})
try {
 $timer.Start()
 [Windows.Forms.Application]::Run()
} finally {
 $timer.Stop(); $timer.Dispose(); $tray.Visible=$false; $tray.Dispose()
 $form.Dispose(); $client.Dispose()
}
