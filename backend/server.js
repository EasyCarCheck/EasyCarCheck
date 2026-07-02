$body = @{
    url = "https://www.autoscout24.ch/fr/d/bmw-m3-competition-12905971"
    email = "mitruccio.marco@gmail.com"
    langue = "fr"
} | ConvertTo-Json

Invoke-RestMethod -Uri "https://amused-perception-production-eaaf.up.railway.app/test-rapport" -Method POST -Body $body -ContentType "application/json"
